import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyDraft, type ProviderDraft, type ProviderModel } from "../src/types.ts";
import { providerId } from "../src/endpoints.ts";
import {
  deleteProvider,
  loadProviderDraft,
  loadSavedProviders,
  saveProvider,
} from "../src/storage.ts";

const files = ["models.json", "auth.json", "settings.json", "provider-adder.json"];
let serial = 0;

function draft(): ProviderDraft {
  return {
    ...emptyDraft(),
    name: "test-provider",
    baseUrl: "https://example.com",
    keys: ["dummy-one", "!$dummy-two"],
    selectedKey: 1,
    models: [{ id: "model-a" }],
    selectedModelIds: ["model-a"],
  };
}

async function temporary(t: TestContext): Promise<string> {
  const root = join(tmpdir(), `pi-storage-${process.pid}-${Date.now()}-${serial++}`);
  await mkdir(root, { mode: 0o700 });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return join(root, "agent");
}

async function put(dir: string, file: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, file), JSON.stringify(value), { mode: 0o600 });
}

async function json(dir: string, file: string): Promise<any> {
  return JSON.parse(await readFile(join(dir, file), "utf8"));
}

async function snapshot(dir: string): Promise<(string | undefined)[]> {
  return Promise.all(files.map(async file => {
    try { return await readFile(join(dir, file), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }));
}

async function unchangedFailure(dir: string, d: ProviderDraft, reserved: readonly string[] = []): Promise<void> {
  const before = await snapshot(dir);
  await assert.rejects(saveProvider(d, reserved, dir));
  assert.deepEqual(await snapshot(dir), before);
}

test("save uses native auth, literal values, private metadata and safe summaries", async t => {
  const dir = await temporary(t);
  const d = draft();
  d.headers = { "X-Literal": "!$HOME", "X-Dollar": "$TOKEN" };
  d.models = [{ id: "model-a", reasoning: true, thinkingLevelMap: { off: "none", high: "extended", max: null } }];
  const result = await saveProvider(d, [], dir, []);
  assert.ok(result.providerId);
  assert.equal(result.providerName, "test-provider");
  assert.deepEqual(result.enabledModels, [`${result.providerId}/model-a`]);
  const id = result.providerId;

  const models = await json(dir, "models.json");
  const provider = models.providers[id];
  assert.equal(provider.name, d.name);
  assert.equal(provider.baseUrl, "https://example.com/v1");
  assert.equal(provider.api, "openai-responses");
  assert.equal(provider.authHeader, true);
  assert.equal(new Headers(provider.headers).get("X-Literal"), "$!$$HOME");
  assert.equal(new Headers(provider.headers).get("X-Dollar"), "$$TOKEN");
  assert.deepEqual(provider.models, [{
    id: "model-a", contextWindow: 128000, maxTokens: 16384, reasoning: true,
    thinkingLevelMap: { off: "none", high: "extended", max: null }, input: ["text"],
  }]);
  assert.equal(Object.hasOwn(models, "enabledModels"), false);

  const modelBytes = await readFile(join(dir, "models.json"), "utf8");
  for (const key of d.keys) assert.equal(modelBytes.includes(key), false);
  const auth = await json(dir, "auth.json");
  assert.deepEqual(auth[id], { type: "api_key", key: "$!$$dummy-two" });

  const metadata = await json(dir, "provider-adder.json");
  assert.equal(metadata.version, 1);
  const savedMetadata = metadata.providers[id];
  assert.equal(savedMetadata.editingId, id);
  assert.equal(savedMetadata.preserveConnection, false);
  assert.deepEqual(savedMetadata.keys, d.keys);
  assert.equal(savedMetadata.selectedKey, 1);
  assert.equal(savedMetadata.skin, "pi");
  assert.deepEqual(savedMetadata.headers, d.headers);
  assert.deepEqual(savedMetadata.models, provider.models);
  assert.deepEqual(savedMetadata.selectedModelIds, ["model-a"]);

  const summaries = await loadSavedProviders(dir);
  const summary = summaries.find(p => p.id === id);
  assert.ok(summary);
  assert.equal(summary.name, "test-provider");
  assert.equal(summary.modelCount, 1);
  assert.equal(summary.custom, true);
  for (const key of d.keys) assert.equal(JSON.stringify(summaries).includes(key), false);

  if (process.platform !== "win32") {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    for (const file of ["models.json", "auth.json", "provider-adder.json", "settings.json"]) {
      assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
    }
  }
  await assert.rejects(stat(join(dir, "auth.json.lock")), { code: "ENOENT" });
});

test("preserves unrelated configuration and appends explicit scope while setting defaults", async t => {
  const dir = await temporary(t);
  const legacy = {
    baseUrl: "https://legacy.example/v1",
    api: "openai-completions",
    models: [{ id: "old", name: "Old" }],
  };
  const credential = { type: "api_key", key: "dummy-legacy" };
  await put(dir, "models.json", { extra: { keep: true }, providers: { legacy } });
  await put(dir, "auth.json", { legacy: credential });
  await put(dir, "settings.json", {
    theme: "dark",
    defaultProvider: "legacy",
    defaultModel: "old",
    enabledModels: ["legacy/*"],
    extra: { keep: true },
  });

  const d = draft();
  d.defaultModelId = "model-a";
  const first = await saveProvider(d, [], dir, ["legacy/*"]);
  const firstMetadata = (await json(dir, "provider-adder.json")).providers[first.providerId];

  const secondDraft = draft();
  secondDraft.name = "second-provider";
  const second = await saveProvider(secondDraft, [], dir, first.enabledModels);

  const models = await json(dir, "models.json");
  assert.deepEqual(models.providers.legacy, legacy);
  assert.deepEqual(models.extra, { keep: true });
  assert.ok(models.providers[first.providerId]);
  assert.equal(Object.hasOwn(models, "enabledModels"), false);
  assert.deepEqual((await json(dir, "auth.json")).legacy, credential);
  assert.deepEqual((await json(dir, "provider-adder.json")).providers[first.providerId], firstMetadata);

  const settings = await json(dir, "settings.json");
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.extra, { keep: true });
  assert.equal(settings.defaultProvider, first.providerId);
  assert.equal(settings.defaultModel, "model-a");
  assert.equal(first.defaultModelId, "model-a");
  assert.deepEqual(settings.enabledModels, [
    "legacy/*",
    `${first.providerId}/model-a`,
    `${second.providerId}/model-a`,
  ]);
  assert.deepEqual(second.enabledModels, settings.enabledModels);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(dir, "settings.json"))).mode & 0o777, 0o600);
  }
});

test("explicit scope selection is replaced and direct unscoped calls stay unscoped", async t => {
  const explicit = await temporary(t);
  const unscoped = await temporary(t);
  const first = draft();
  first.models.push({ id: "model-b" });
  first.selectedModelIds = ["model-a", "model-b"];

  const firstResult = await saveProvider(first, [], explicit, ["other/model"]);
  const id = firstResult.providerId;
  assert.deepEqual(firstResult.enabledModels, ["other/model", `${id}/model-a`, `${id}/model-b`]);

  const edited = draft();
  edited.editingId = id;
  edited.name = "renamed provider";
  edited.models.push({ id: "model-b" });
  edited.selectedModelIds = ["model-b"];
  edited.defaultModelId = "model-b";
  const secondResult = await saveProvider(edited, [], explicit, [
    "other/model", `${id}/model-a`, "unrelated/provider:model",
  ]);
  assert.equal(secondResult.providerId, id);
  assert.deepEqual(secondResult.enabledModels, ["other/model", "unrelated/provider:model", `${id}/model-b`]);
  const settings = await json(explicit, "settings.json");
  assert.deepEqual(settings.enabledModels, secondResult.enabledModels);
  assert.equal(settings.defaultProvider, id);
  assert.equal(settings.defaultModel, "model-b");

  const direct = draft();
  const directResult = await saveProvider(direct, [], unscoped, undefined);
  assert.deepEqual(directResult.enabledModels, [`${directResult.providerId}/model-a`]);
  await assert.rejects(stat(join(unscoped, "settings.json")), { code: "ENOENT" });
});

test("persists each protocol using its native API and authentication behavior", async t => {
  const cases = [
    ["responses", "openai-responses", "https://example.com/v1", true],
    ["chat", "openai-completions", "https://example.com/v1", true],
    ["messages", "anthropic-messages", "https://example.com", false],
    ["generative", "google-generative-ai", "https://example.com/v1beta", false],
  ] as const;
  for (const [method, api, baseUrl, bearer] of cases) {
    await t.test(method, async st => {
      const dir = await temporary(st);
      const d = draft();
      d.method = method;
      if (method === "generative") d.baseUrl += "/v1beta";
      const result = await saveProvider(d, [], dir, []);
      const provider = (await json(dir, "models.json")).providers[result.providerId];
      assert.equal(provider.api, api);
      assert.equal(provider.baseUrl, baseUrl);
      if (bearer) assert.equal(provider.authHeader, true);
      else assert.notEqual(provider.authHeader, true);
    });
  }
});

test("editing keeps a stable ID and restores full addon metadata", async t => {
  const dir = await temporary(t);
  const original = draft();
  original.models = [
    { id: "model-a", reasoning: true, thinkingLevelMap: { low: "provider-low" } },
    { id: "model-b", name: "Model B", contextWindow: 200000, maxTokens: 32000 },
  ];
  original.selectedModelIds = ["model-a", "model-b"];
  const first = await saveProvider(original, [], dir, []);

  const restored = await loadProviderDraft(first.providerId, [], dir);
  assert.equal(restored.editingId, first.providerId);
  assert.equal(restored.preserveConnection, false);
  assert.deepEqual(restored.keys, original.keys);
  assert.equal(restored.selectedKey, 1);
  assert.deepEqual(restored.models, (await json(dir, "models.json")).providers[first.providerId].models);
  assert.deepEqual(restored.selectedModelIds, ["model-a", "model-b"]);

  restored.name = "renamed-provider";
  restored.selectedModelIds = ["model-b"];
  delete restored.defaultModelId;
  const second = await saveProvider(restored, [], dir, first.enabledModels);
  assert.equal(second.providerId, first.providerId);
  assert.equal(second.providerName, "renamed-provider");
  const metadata = await json(dir, "provider-adder.json");
  assert.equal(Object.hasOwn(metadata.providers, providerId("renamed-provider", "https://example.com")), false);
  assert.equal(metadata.providers[first.providerId].name, "renamed-provider");
  assert.deepEqual(metadata.providers[first.providerId].models.map((model: ProviderModel) => model.id), ["model-a", "model-b"]);
  assert.deepEqual(metadata.providers[first.providerId].selectedModelIds, ["model-b"]);
});

test("native providers list and OAuth edits preserve credentials, endpoint and protocol", async t => {
  const dir = await temporary(t);
  const oauth = {
    type: "oauth",
    access: "dummy-access-token",
    refresh: "dummy-refresh-token",
    expires: 1893456000,
    nativeProtocol: "keep-me",
  };
  const nativeConfig = {
    baseUrl: "https://native.example/v1",
    api: "openai-responses",
    headers: { "X-Native": "native-value" },
    nativeProtocol: "oauth",
    extra: { keep: true },
    modelOverrides: { "native-model-a": { name: "Keep label" }, "native-model-b": { maxTokens: 12000 } },
    models: [
      { id: "native-model-a", reasoning: false },
      { id: "native-model-b", reasoning: true },
    ],
  };
  const available: ProviderModel[] = [
    { id: "native-model-a", reasoning: false },
    { id: "native-model-b", reasoning: true, thinkingLevelMap: { high: "native-high" } },
  ];
  await put(dir, "auth.json", { native: oauth, unrelated: { type: "api_key", key: "dummy-unrelated" } });
  await put(dir, "models.json", {
    providers: {
      native: nativeConfig,
      "catalog-only": { baseUrl: "https://catalog.example/v1", api: "openai-responses", models: [{ id: "catalog-model" }] },
    },
  });
  await put(dir, "settings.json", { enabledModels: ["native/native-model-a", "other/other-model"] });

  const summaries = await loadSavedProviders(dir);
  assert.deepEqual(summaries.map(summary => summary.id), ["native", "unrelated"]);
  assert.equal(summaries[0].modelCount, 2);
  assert.equal(JSON.stringify(summaries).includes("dummy-access-token"), false);
  assert.equal(JSON.stringify(summaries).includes("dummy-refresh-token"), false);

  const restored = await loadProviderDraft("native", available, dir);
  assert.equal(restored.preserveConnection, true);
  assert.deepEqual(restored.keys, []);
  assert.equal(restored.baseUrl, "https://native.example/v1");
  assert.equal(restored.method, "responses");
  assert.deepEqual(restored.selectedModelIds, ["native-model-a"]);

  restored.name = "Native Renamed";
  restored.selectedModelIds = ["native-model-b"];
  restored.defaultModelId = "native-model-b";
  const authBefore = await readFile(join(dir, "auth.json"), "utf8");
  const result = await saveProvider(restored, [], dir, ["other/other-model", "native/native-model-a"]);
  const authAfter = await readFile(join(dir, "auth.json"), "utf8");
  assert.equal(authAfter, authBefore);

  const models = await json(dir, "models.json");
  const savedNative = models.providers.native;
  assert.equal(savedNative.baseUrl, nativeConfig.baseUrl);
  assert.equal(savedNative.api, nativeConfig.api);
  assert.deepEqual(savedNative.headers, nativeConfig.headers);
  assert.equal(savedNative.nativeProtocol, nativeConfig.nativeProtocol);
  assert.deepEqual(savedNative.extra, nativeConfig.extra);
  assert.deepEqual(savedNative.models, nativeConfig.models);
  assert.deepEqual(savedNative.modelOverrides, {
    "native-model-a": { name: "Keep label" },
    "native-model-b": { maxTokens: 12000, reasoning: true, thinkingLevelMap: { high: "native-high" } },
  });
  const modelsBytes = await readFile(join(dir, "models.json"), "utf8");
  const metadataBytes = await readFile(join(dir, "provider-adder.json"), "utf8");
  for (const bytes of [modelsBytes, metadataBytes]) {
    assert.equal(bytes.includes("dummy-access-token"), false);
    assert.equal(bytes.includes("dummy-refresh-token"), false);
  }
  assert.equal(result.providerId, "native");
  assert.deepEqual(result.enabledModels, ["other/other-model", "native/native-model-b"]);
  const settings = await json(dir, "settings.json");
  assert.deepEqual(settings.enabledModels, result.enabledModels);
  assert.deepEqual((await json(dir, "auth.json")).native, oauth);
});

test("delete removes only the target provider and exact settings choices", async t => {
  const dir = await temporary(t);
  const target = draft();
  target.defaultModelId = "model-a";
  const first = await saveProvider(target, [], dir, ["other/model"]);

  const other = draft();
  other.name = "other-provider";
  other.defaultModelId = "model-a";
  const second = await saveProvider(other, [], dir, [
    ...first.enabledModels!, "unrelated/model",
  ]);

  await put(dir, "auth.json", {
    ...await json(dir, "auth.json"),
    native: { type: "oauth", access: "dummy-access", refresh: "dummy-refresh", expires: 1893456000 },
  });
  const settings = await json(dir, "settings.json");
  settings.modelThinkingLevels = {
    [`${first.providerId}/model-a`]: "high",
    [`${second.providerId}/model-a`]: "medium",
    "unrelated/model": "low",
  };
  await put(dir, "settings.json", settings);

  await deleteProvider(first.providerId, dir);
  const auth = await json(dir, "auth.json");
  const models = await json(dir, "models.json");
  const metadata = await json(dir, "provider-adder.json");
  assert.equal(Object.hasOwn(auth, first.providerId), false);
  assert.equal(Object.hasOwn(models.providers, first.providerId), false);
  assert.equal(Object.hasOwn(metadata.providers, first.providerId), false);
  assert.ok(auth[second.providerId]);
  assert.ok(auth.native);
  assert.ok(models.providers[second.providerId]);
  assert.ok(metadata.providers[second.providerId]);
  assert.equal(settings.defaultProvider !== first.providerId, true);

  const nextSettings = await json(dir, "settings.json");
  assert.deepEqual(new Set(nextSettings.enabledModels), new Set([
    "other/model",
    `${second.providerId}/model-a`,
    "unrelated/model",
  ]));
  assert.deepEqual(nextSettings.modelThinkingLevels, {
    [`${second.providerId}/model-a`]: "medium",
    "unrelated/model": "low",
  });
  assert.equal(nextSettings.defaultProvider, second.providerId);
  assert.equal(nextSettings.defaultModel, "model-a");
});

test("delete validates IDs and leaves unrelated files untouched when target is absent", async t => {
  const dir = await temporary(t);
  await put(dir, "auth.json", { unrelated: { type: "api_key", key: "dummy-unrelated" } });
  await put(dir, "models.json", { providers: { unrelated: { models: [{ id: "model" }] } } });
  await put(dir, "provider-adder.json", { version: 1, providers: { unrelated: { name: "Unrelated" } } });
  await put(dir, "settings.json", { enabledModels: ["unrelated/model"], defaultProvider: "unrelated", defaultModel: "model" });
  const before = await snapshot(dir);
  for (const id of ["", " bad", "../bad", "__proto__"]) await assert.rejects(deleteProvider(id, dir));
  await deleteProvider("missing", dir);
  assert.deepEqual(await snapshot(dir), before);
});

test("reserved, builtin, custom, saved, auth, editing and preserve-connection collisions leave files untouched", async t => {
  for (const kind of ["reserved", "builtin", "custom", "saved", "auth", "editing", "preserve-new", "missing-edit", "invalid-map"]) {
    await t.test(kind, async st => {
      const dir = await temporary(st);
      const d = draft();
      if (kind === "builtin") d.name = "openai";
      const id = kind === "editing" || kind === "missing-edit" ? "test-provider" : providerId(d.name, d.baseUrl);
      await put(dir, "settings.json", { theme: "dark" });
      if (kind === "custom") await put(dir, "models.json", {
        providers: { [id]: { baseUrl: "https://other.example/v1", api: "openai-completions", models: [{ id: "old", name: "Old" }] } },
      });
      if (kind === "auth") await put(dir, "auth.json", { [id]: { type: "api_key", key: "dummy-other" } });
      if (kind === "saved") await saveProvider(d, [], dir, []);
      if (kind === "editing") {
        const result = await saveProvider(d, [], dir, []);
        d.name = "new name";
        d.editingId = result.providerId;
        d.models[0].thinkingLevelMap = { low: 12 } as never;
      }
      if (kind === "missing-edit") d.editingId = id;
      if (kind === "preserve-new") d.preserveConnection = true;
      if (kind === "invalid-map") {
        const result = await saveProvider(d, [], dir, []);
        d.editingId = result.providerId;
        d.models[0].thinkingLevelMap = { bogus: "value" } as never;
      }
      await unchangedFailure(dir, d, kind === "reserved" || kind === "builtin" ? [id] : []);
    });
  }
});

test("invalid drafts cannot partially modify existing files", async t => {
  const invalid: [string, (d: ProviderDraft) => void][] = [
    ["userinfo URL", d => { d.baseUrl = "https://user:pass@example.com"; }],
    ["prototype name", d => { d.name = "__proto__"; }],
    ["no keys", d => { d.keys = []; }],
    ["key index", d => { d.selectedKey = 2; }],
    ["header auth override", d => { d.headers.Authorization = "dummy-override"; }],
    ["header newline", d => { d.headers["X-Test"] = "a\nb"; }],
    ["zero context", d => { d.models[0].contextWindow = 0; }],
    ["infinite output", d => { d.models[0].maxTokens = Infinity; }],
    ["output exceeds context", d => { d.models[0].contextWindow = 10; d.models[0].maxTokens = 11; }],
    ["missing selected model", d => { d.selectedModelIds = ["missing"]; }],
    ["empty selection", d => { d.selectedModelIds = []; }],
    ["unselected default", d => { d.models.push({ id: "model-b" }); d.defaultModelId = "model-b"; }],
    ["invalid thinking reasoning", d => { d.models[0].reasoning = "yes" as never; }],
    ["invalid thinking map", d => { d.models[0].thinkingLevelMap = { low: 12 } as never; }],
  ];
  for (const [name, mutate] of invalid) {
    await t.test(name, async st => {
      const dir = await temporary(st);
      await put(dir, "settings.json", { theme: "dark" });
      await put(dir, "auth.json", { other: { type: "api_key", key: "dummy-other" } });
      const d = draft();
      mutate(d);
      await unchangedFailure(dir, d);
    });
  }
});

test("corrupt files and unknown metadata schemas are refused before writes", async t => {
  const cases: [string, string][] = files.map(file => [file, "{broken"]);
  cases.push(["provider-adder.json", JSON.stringify({ version: 99, providers: {} })]);
  cases.push(["settings.json", JSON.stringify({ enabledModels: "invalid" })]);
  for (const [index, [file, bytes]] of cases.entries()) {
    await t.test(`${file} ${index}`, async st => {
      const dir = await temporary(st);
      await put(dir, "settings.json", { theme: "dark" });
      await writeFile(join(dir, file), bytes, { mode: 0o600 });
      await unchangedFailure(dir, draft());
      if (file === "models.json" || file === "provider-adder.json") {
        await assert.rejects(loadSavedProviders(dir));
      }
    });
  }
});

test("listing an absent storage directory is empty and does not create files", async t => {
  const dir = await temporary(t);
  assert.deepEqual(await loadSavedProviders(dir), []);
  await assert.rejects(loadProviderDraft("missing", [], dir), /Provider not found/);
  await assert.rejects(stat(dir), { code: "ENOENT" });
});

test("delete preserves newer provider settings it cannot read", async t => {
  const dir = await temporary(t);
  await put(dir, "provider-adder.json", { version: 99, providers: { target: { name: "Target" } } });
  const before = await snapshot(dir);
  await assert.rejects(deleteProvider("target", dir), /unsupported format/);
  assert.deepEqual(await snapshot(dir), before);
});

test("concurrent saves merge both providers without losing credentials", async t => {
  const dir = await temporary(t);
  const one = draft();
  const two = draft();
  two.name = "other-provider";
  const results = await Promise.all([
    saveProvider(one, [], dir, ["shared/model"]),
    saveProvider(two, [], dir, ["shared/model"]),
  ]);
  const models = await json(dir, "models.json");
  const auth = await json(dir, "auth.json");
  const metadata = await json(dir, "provider-adder.json");
  for (const result of results) {
    assert.ok(models.providers[result.providerId]);
    assert.ok(auth[result.providerId]);
    assert.ok(metadata.providers[result.providerId]);
  }
  const settings = await json(dir, "settings.json");
  assert.deepEqual(new Set(settings.enabledModels), new Set([
    "shared/model", ...results.flatMap(result => result.enabledModels ?? []),
  ]));
});
