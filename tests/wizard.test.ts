import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { ProviderWizard } from "../src/wizard.ts";
import type { KeyCheck, ProviderDraft, ProviderModel } from "../src/types.ts";

const ENTER = "\r";
const ESC = "\x1b";
const ALL = "\x01";
const CLEAR = "\x05";
const DEFAULT = "\x04";
const REVIEW = "\x13";
const CHECK = "\x0b";
const CLEAR_LINE = "\x15";
const KEY = "dummy-key-one";

type Services = {
  fetchModels: (draft: ProviderDraft, signal?: AbortSignal) => Promise<ProviderModel[]>;
  checkKey: (draft: ProviderDraft, signal?: AbortSignal) => Promise<KeyCheck>;
};

function plain(value: string): string {
  return stripVTControlCharacters(value.replace(/\x1b_[^\x07]*\x07/g, ""));
}

function initial(): ProviderDraft {
  return {
    name: "Retained provider",
    baseUrl: "https://example.com/v1",
    method: "responses",
    keys: [KEY, "dummy-key-two"],
    selectedKey: 1,
    skin: "pi",
    headers: { "X-Draft": "kept" },
    models: [{ id: "manual-seed", contextWindow: 128000, maxTokens: 16384 }],
    selectedModelIds: ["manual-seed"],
    defaultModelId: "manual-seed",
  };
}

function setup(t: TestContext, draft?: ProviderDraft, services: Partial<Services> = {}) {
  const results: (ProviderDraft | undefined)[] = [];
  const counts = { fetch: 0, check: 0, refresh: 0 };
  const wizard = new ProviderWizard({
    theme: { fg: (_color: string, text: string) => text },
    refresh: () => { counts.refresh++; },
    rows: () => 24,
    done: (value: ProviderDraft | undefined) => { results.push(value); },
    initialDraft: draft,
    services: {
      fetchModels: (value, signal) => {
        counts.fetch++;
        return services.fetchModels?.(value, signal) ?? Promise.resolve([]);
      },
      checkKey: (value, signal) => {
        counts.check++;
        return services.checkKey?.(value, signal) ?? Promise.resolve({ status: "valid", message: "Accepted" });
      },
    },
  });
  wizard.focused = true;
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      wizard.dispose();
    }
  };
  t.after(dispose);
  return {
    wizard, results, counts, dispose,
    press: (...keys: string[]) => { for (const key of keys) wizard.handleInput(key); },
    paste: (value: string) => wizard.handleInput(`\x1b[200~${value}\x1b[201~`),
    view: (width = 100) => plain(wizard.render(width).join("\n")),
  };
}

type Harness = ReturnType<typeof setup>;

function keyToModels(h: Harness, key = KEY): void {
  h.paste(key);
  h.press(ENTER, ENTER, ENTER);
}

function toModels(h: Harness): void {
  h.press(ENTER);
  h.paste("example.com");
  h.press(ENTER, ENTER);
  keyToModels(h);
}

function manual(h: Harness, id: string, name = ""): void {
  h.press("n");
  for (const value of [id, name, "", "", "", ""]) {
    if (value) h.paste(value);
    h.press(ENTER);
  }
}

function finish(h: Harness): ProviderDraft {
  h.press(REVIEW);
  assert.equal(h.results.length, 0, "Review must require a separate confirmation");
  h.press(ENTER);
  assert.equal(h.results.length, 1);
  const result = h.results[0];
  assert.ok(result, "Expected a confirmed draft");
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Escape at Name cancels without network activity", (t) => {
  const h = setup(t);
  h.view();
  h.press(ESC);
  assert.deepEqual(h.results, [undefined]);
  assert.equal(h.counts.fetch, 0);
  assert.equal(h.counts.check, 0);
});

test("manual model flow uses defaults and only final Enter confirms", (t) => {
  const h = setup(t);
  toModels(h);
  assert.equal(h.counts.fetch, 0);
  assert.equal(h.counts.check, 0);
  manual(h, "manual-one", "Manual One");
  h.press(DEFAULT);
  const saved = finish(h);
  assert.equal(new URL(saved.baseUrl).hostname, "example.com");
  assert.equal(saved.method, "responses");
  assert.deepEqual(saved.keys, [KEY]);
  assert.equal(saved.selectedKey, 0);
  assert.deepEqual(saved.selectedModelIds, ["manual-one"]);
  assert.equal(saved.defaultModelId, "manual-one");
  const model = saved.models.find((value) => value.id === "manual-one");
  assert.ok(model);
  assert.equal(model.name, "Manual One");
  assert.equal(model.contextWindow, 128000);
  assert.equal(model.maxTokens, 16384);
  assert.ok(!model.reasoning);
  assert.ok(!model.input?.includes("image"));
  assert.equal(h.counts.fetch, 0);
  assert.equal(h.counts.check, 0);
});

test("initial draft starts at Review and survives back navigation through every step", (t) => {
  const draft = initial();
  const h = setup(t, draft);
  assert.match(h.view(), /review/i);
  assert.match(h.view(), /Retained provider/);
  h.press(ESC);
  assert.match(h.view(), /manual-seed/);
  h.press(ESC);
  assert.match(h.view(), /X-Draft/i);
  h.press(ESC);
  assert.ok(!h.view().includes(KEY));
  assert.ok(!h.view().includes("dummy-key-two"));
  h.press(ESC, ESC);
  assert.match(h.view(), /https:\/\/example\.com\/v1/);
  h.press(ESC);
  assert.match(h.view(), /Retained provider/);
  h.press(ENTER, ENTER, ENTER, ENTER, ENTER);
  const saved = finish(h);
  assert.equal(saved.name, draft.name);
  assert.equal(saved.baseUrl, draft.baseUrl);
  assert.equal(saved.method, draft.method);
  assert.equal(saved.skin, draft.skin);
  assert.deepEqual(saved.keys, draft.keys);
  assert.equal(saved.selectedKey, draft.selectedKey);
  assert.deepEqual(saved.headers, draft.headers);
  assert.deepEqual(saved.selectedModelIds, draft.selectedModelIds);
  assert.equal(saved.defaultModelId, draft.defaultModelId);
  assert.equal(h.counts.fetch, 0);
  assert.equal(h.counts.check, 0);
});

test("pasted and edited keys stay masked at narrow widths with a forwarded cursor", (t) => {
  const h = setup(t);
  h.press(ENTER);
  h.paste("example.com");
  h.press(ENTER, ENTER);
  const first = "DUMMY-987698769876-SECRET";
  const second = "DUMMY-765476547654-SECRET";
  h.paste(first);
  const checkMasked = () => {
    for (const width of [1, 2, 4, 8, 16, 40, 80]) {
      const lines = h.wizard.render(width);
      assert.ok(lines.length <= 24, `Height overflow at width ${width}`);
      for (const line of lines) {
        const text = plain(line);
        assert.ok(visibleWidth(text) <= width, `Width overflow at ${width}`);
        assert.ok(!text.includes(first));
        assert.ok(!text.includes(second));
        assert.ok(!text.includes("9876"));
        assert.ok(!text.includes("7654"));
      }
    }
  };
  checkMasked();
  assert.ok(h.wizard.render(80).join("").includes(CURSOR_MARKER));
  h.press(CLEAR_LINE);
  h.paste(second);
  h.press("\x7f");
  checkMasked();
  h.press(ENTER);
  checkMasked();
  h.press(ENTER, ENTER);
  manual(h, "masked-model");
  h.press(DEFAULT, REVIEW);
  assert.ok(!h.view().includes("7654"));
  assert.equal(h.results.length, 0);
  h.press(ENTER);
  assert.equal(h.results.length, 1);
  assert.deepEqual(h.results[0]?.keys, [second.slice(0, -1)]);
});

test("Space explicitly discovers models and retains selected manual models and default", async (t) => {
  const h = setup(t, undefined, {
    fetchModels: async () => [{ id: "remote-one" }],
  });
  toModels(h);
  h.view();
  manual(h, "manual-local");
  h.press(DEFAULT);
  assert.equal(h.counts.fetch, 0);
  h.press(" ");
  await settle();
  assert.equal(h.counts.fetch, 1);
  assert.match(h.view(), /remote-one/);
  const saved = finish(h);
  assert.ok(saved.models.some((model) => model.id === "remote-one"));
  assert.ok(saved.models.some((model) => model.id === "manual-local"));
  assert.ok(saved.selectedModelIds.includes("manual-local"));
  assert.equal(saved.defaultModelId, "manual-local");
  assert.equal(h.counts.fetch, 1);
  assert.equal(h.counts.check, 0);
});

test("model selection controls enforce a nonempty selection and clear removed defaults", (t) => {
  const draft = initial();
  draft.models.push({ id: "second" }, { id: "third" });
  const all = setup(t, draft);
  all.press(ESC, CLEAR, REVIEW, ENTER);
  assert.equal(all.results.length, 0, "Empty selection cannot reach confirmation");
  all.press(ALL);
  const selected = finish(all);
  assert.deepEqual([...selected.selectedModelIds].sort(), ["manual-seed", "second", "third"].sort());
  assert.equal(selected.defaultModelId, undefined);

  const toggled = setup(t, draft);
  toggled.press(ESC, CLEAR, DEFAULT, ALL, "a");
  const saved = finish(toggled);
  assert.equal(saved.selectedModelIds.length, 2);
  assert.ok(!saved.selectedModelIds.includes("manual-seed"));
  assert.equal(saved.defaultModelId, undefined);
});

test("Escape and disposal abort pending services and ignore late results", async (t) => {
  for (const operation of ["models", "key"] as const) {
    for (const exit of ["escape", "dispose"] as const) {
      await t.test(`${operation}: ${exit}`, async (t) => {
        const models = deferred<ProviderModel[]>();
        const key = deferred<KeyCheck>();
        const signals: (AbortSignal | undefined)[] = [];
        const h = setup(t, initial(), {
          fetchModels: (_draft, signal) => {
            signals.push(signal);
            return models.promise;
          },
          checkKey: (draft, signal) => {
            assert.equal(draft.keys[draft.selectedKey], "dummy-key-two");
            signals.push(signal);
            return key.promise;
          },
        });
        h.press(ESC);
        if (operation === "key") h.press(ESC, ESC);
        h.press(operation === "models" ? " " : CHECK);
        await settle();
        assert.equal(signals.length, 1);
        const signal = signals[0];
        assert.ok(signal, "Service must receive an abort signal");
        assert.equal(signal.aborted, false);
        if (exit === "escape") h.press(ESC);
        else h.dispose();
        assert.equal(signal.aborted, true);
        const before = h.view();
        const refreshes = h.counts.refresh;
        models.resolve([{ id: "late-result-must-not-appear" }]);
        key.resolve({ status: "valid", message: "late-result-must-not-appear" });
        await settle();
        assert.equal(h.view(), before);
        assert.equal(h.counts.refresh, refreshes);
        assert.equal(h.results.length, 0);
      });
    }
  }
});

test("invalid URL shows inline validation and accepts correction without losing the flow", (t) => {
  const h = setup(t);
  h.press(ENTER);
  h.paste("ftp://example.com");
  h.press(ENTER);
  assert.equal(h.results.length, 0);
  assert.match(h.view(), /invalid|unsupported|https?|scheme|must|only|allowed/i);
  h.press(CLEAR_LINE);
  h.paste("example.com");
  h.press(ENTER, ENTER);
  keyToModels(h);
  manual(h, "corrected-model");
  h.press(DEFAULT);
  const saved = finish(h);
  assert.equal(new URL(saved.baseUrl).protocol, "https:");
  assert.equal(new URL(saved.baseUrl).hostname, "example.com");
  assert.deepEqual(saved.selectedModelIds, ["corrected-model"]);
  assert.equal(h.counts.fetch, 0);
  assert.equal(h.counts.check, 0);
});

test("key add, delete and check controls keep the selected key consistent", async (t) => {
  const checked: string[] = [];
  const h = setup(t, initial(), { checkKey: async (draft) => {
    checked.push(draft.keys[draft.selectedKey]);
    return { status: "valid", message: "Accepted" };
  } });
  h.press(ESC, ESC, ESC, "n");
  h.paste("dummy-third-key"); h.press(ENTER, CHECK);
  await settle();
  assert.deepEqual(checked, ["dummy-third-key"]);
  h.press("d", "d", "d");
  h.paste("dummy-replacement-key"); h.press(ENTER, ENTER, ENTER);
  const saved = finish(h);
  assert.deepEqual(saved.keys, ["dummy-replacement-key"]);
  assert.equal(saved.selectedKey, 0);
});

test("skin choice and custom header add/delete survive the review flow", (t) => {
  const h = setup(t, initial());
  h.press(ESC, ESC, "\x1b[B", " ", "n");
  h.paste("X-Temporary"); h.press(ENTER); h.paste("temporary"); h.press(ENTER, "d", "n");
  h.paste("User-Agent"); h.press(ENTER); h.paste("custom-client");
  assert.ok(!h.view().includes("custom-client"), "Header values stay hidden during entry");
  h.press(ENTER, ENTER);
  const saved = finish(h);
  assert.equal(saved.skin, "claude-code");
  assert.equal(saved.headers["User-Agent"], "custom-client");
  assert.equal(saved.headers["X-Temporary"], undefined);
  assert.equal(saved.headers["X-Draft"], "kept");
});
