import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyDraft, type ProviderDraft } from "../src/types.ts";
import { providerId } from "../src/endpoints.ts";
import { saveProvider, loadSavedProviders } from "../src/storage.ts";

const files = ["models.json", "auth.json", "settings.json", "provider-adder.json"];
let serial = 0;
function draft(): ProviderDraft {
  return {
    ...emptyDraft(), name: "test-provider", baseUrl: "https://example.com",
    keys: ["dummy-one", "!$dummy-two"], selectedKey: 1,
    models: [{ id: "model-a" }], selectedModelIds: ["model-a"],
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
async function unchangedFailure(dir: string, d: ProviderDraft, reserved: string[] = []): Promise<void> {
  const before = await snapshot(dir);
  await assert.rejects(saveProvider(d, reserved, dir));
  assert.deepEqual(await snapshot(dir), before);
}

test("save uses native auth, literal values, private metadata and safe summaries", async t => {
  const dir = await temporary(t);
  const d = draft();
  d.headers = { "X-Literal": "!$HOME", "X-Dollar": "$TOKEN" };
  const result = await saveProvider(d, [], dir);
  assert.ok(result.providerId);
  assert.equal(result.providerName, "test-provider");
  const id = result.providerId;
  const models = await json(dir, "models.json");
  const p = models.providers[id];
  assert.equal(p.name, d.name);
  assert.equal(p.baseUrl, "https://example.com/v1");
  assert.equal(p.api, "openai-responses");
  assert.equal(p.authHeader, true);
  assert.equal(new Headers(p.headers).get("X-Literal"), "$!$$HOME");
  assert.equal(new Headers(p.headers).get("X-Dollar"), "$$TOKEN");
  assert.deepEqual(p.models.map((m: { id: string }) => m.id), ["model-a"]);
  assert.equal(Object.hasOwn(models, "enabledModels"), false);
  const modelBytes = await readFile(join(dir, "models.json"), "utf8");
  for (const key of d.keys) assert.equal(modelBytes.includes(key), false);
  const auth = await json(dir, "auth.json");
  assert.deepEqual(auth[id], { type: "api_key", key: "$!$$dummy-two" });
  const metadata = await json(dir, "provider-adder.json");
  assert.equal(metadata.version, 1);
  assert.deepEqual(metadata.providers[id].keys, d.keys);
  assert.equal(metadata.providers[id].selectedKey, 1);
  assert.equal(metadata.providers[id].skin, "pi");
  assert.deepEqual(metadata.providers[id].headers, d.headers);
  const summaries = await loadSavedProviders(dir);
  const summary = summaries.find(p => p.id === id);
  assert.ok(summary);
  assert.equal(summary.name, "test-provider");
  assert.equal(summary.modelCount, 1);
  assert.equal(summary.custom, true);
  for (const key of d.keys) assert.equal(JSON.stringify(summaries).includes(key), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    for (const file of ["models.json", "auth.json", "provider-adder.json"]) {
      assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
    }
  }
  await assert.rejects(stat(join(dir, "auth.json.lock")), { code: "ENOENT" });
});

test("preserves unrelated configuration and appends scope while setting explicit defaults", async t => {
  const dir = await temporary(t);
  const legacy = { baseUrl: "https://legacy.example/v1", api: "openai-completions", models: [{ id: "old", name: "Old" }] };
  const credential = { type: "api_key", key: "dummy-legacy" };
  await put(dir, "models.json", { extra: { keep: true }, providers: { legacy } });
  await put(dir, "auth.json", { legacy: credential });
  await put(dir, "settings.json", {
    theme: "dark", defaultProvider: "legacy", defaultModel: "old",
    enabledModels: ["legacy/*"], extra: { keep: true },
  });
  const d = draft();
  d.defaultModelId = "model-a";
  const first = await saveProvider(d, [], dir);
  const firstMetadata = (await json(dir, "provider-adder.json")).providers[first.providerId];
  const secondDraft = draft();
  secondDraft.name = "second-provider";
  await saveProvider(secondDraft, [], dir);
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
  assert.ok(settings.enabledModels.includes("legacy/*"));
  assert.ok(settings.enabledModels.includes(`${first.providerId}/model-a`));
  if (process.platform !== "win32") assert.equal((await stat(join(dir, "settings.json"))).mode & 0o777, 0o600);
});

test("unscoped settings stay unscoped and unmarked defaults stay unchanged", async t => {
  for (const scope of [undefined, []] as (undefined | string[])[]) {
    await t.test(scope ? "empty scope" : "absent scope", async st => {
      const dir = await temporary(st);
      const settings = { defaultProvider: "legacy", defaultModel: "old", ...(scope ? { enabledModels: scope } : {}) };
      await put(dir, "settings.json", settings);
      await saveProvider(draft(), [], dir);
      assert.deepEqual(await json(dir, "settings.json"), settings);
    });
  }
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
      const result = await saveProvider(d, [], dir);
      const p = (await json(dir, "models.json")).providers[result.providerId];
      assert.equal(p.api, api);
      assert.equal(p.baseUrl, baseUrl);
      if (bearer) assert.equal(p.authHeader, true);
      else assert.notEqual(p.authHeader, true);
    });
  }
});

test("reserved, builtin, custom, saved and auth collisions leave all files untouched", async t => {
  for (const kind of ["reserved", "builtin", "custom", "saved", "auth"]) {
    await t.test(kind, async st => {
      const dir = await temporary(st);
      const d = draft();
      if (kind === "builtin") d.name = "openai";
      const id = providerId(d.name, d.baseUrl);
      await put(dir, "settings.json", { theme: "dark" });
      if (kind === "custom") await put(dir, "models.json", {
        providers: { [id]: { baseUrl: "https://other.example/v1", api: "openai-completions", models: [{ id: "old", name: "Old" }] } },
      });
      if (kind === "auth") await put(dir, "auth.json", { [id]: { type: "api_key", key: "dummy-other" } });
      if (kind === "saved") await saveProvider(d, [], dir);
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
  for (const [index, [file, bytes]] of cases.entries()) {
    await t.test(`${file} ${index}`, async st => {
      const dir = await temporary(st);
      await put(dir, "settings.json", { theme: "dark" });
      await writeFile(join(dir, file), bytes, { mode: 0o600 });
      await unchangedFailure(dir, draft());
      if (file === "models.json") {
        await assert.rejects(loadSavedProviders(dir));
      }
    });
  }
});

test("listing an absent storage directory is empty and does not create files", async t => {
  const dir = await temporary(t);
  assert.deepEqual(await loadSavedProviders(dir), []);
  await assert.rejects(stat(dir), { code: "ENOENT" });
});

test("concurrent saves merge both providers without losing credentials", async t => {
  const dir = await temporary(t);
  const one = draft();
  const two = draft(); two.name = "other-provider";
  const results = await Promise.all([saveProvider(one, [], dir), saveProvider(two, [], dir)]);
  const models = await json(dir, "models.json");
  const auth = await json(dir, "auth.json");
  const metadata = await json(dir, "provider-adder.json");
  for (const result of results) {
    assert.ok(models.providers[result.providerId]);
    assert.ok(auth[result.providerId]);
    assert.ok(metadata.providers[result.providerId]);
  }
});
