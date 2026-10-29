import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ProviderList, type ProviderAction } from "../src/provider-list.ts";
import type { ProviderSummary } from "../src/types.ts";

const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

const providers: ProviderSummary[] = [
  { id: "alpha", name: "Alpha Provider", api: "openai-responses", modelCount: 3, custom: true },
  { id: "beta", name: "Beta Provider", api: "anthropic-messages", modelCount: 12, custom: true },
  { id: "gamma", name: "Gamma Provider", api: "openai-codex-responses", modelCount: 0, custom: false },
];

function plain(value: string): string {
  return stripVTControlCharacters(value.replace(/\x1b_[^\x07]*\x07/g, ""));
}

function setup(t: TestContext, rows = 24) {
  const actions: (ProviderAction | undefined)[] = [];
  let refreshes = 0;
  const styles: string[] = [];
  const list = new ProviderList({
    theme: {
      fg: (color: string, text: string) => {
        styles.push(`${color}:${text}`);
        return `\u001b[${color === "dim" ? 2 : color === "accent" ? 1 : 7}m${text}\u001b[0m`;
      },
    },
    refresh: () => { refreshes++; },
    rows: () => rows,
    done: (result) => { actions.push(result); },
    providers,
  });
  list.focused = true;
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      list.dispose();
    }
  };
  t.after(dispose);
  return {
    list, actions, refreshes, styles, dispose,
    press: (...keys: string[]) => { for (const key of keys) list.handleInput(key); },
    paste: (text: string) => list.handleInput(`\x1b[200~${text}\x1b[201~`),
    lines: (width = 100) => list.render(width).map(plain),
  };
}

type Harness = ReturnType<typeof setup>;

function rows(h: Harness): void {
  h.press(TAB);
}

test("search defaults to focus and typing d or e never triggers an action", (t) => {
  const h = setup(t);
  assert.equal(h.list.focused, true);
  assert.equal(h.list.searchFocused, true);
  h.press("d", "e", ENTER);
  assert.deepEqual(h.actions, []);
  assert.equal(h.lines()[2].trim(), "> de");
  h.press(ESC);
  assert.deepEqual(h.actions, [undefined]);
});

test("Tab focuses rows, navigation targets edit and delete correctly", (t) => {
  // Tab also moves the search-to-row focus transition; arrows then navigate rows.
  const edit = setup(t);
  edit.press(TAB, DOWN, "e");
  assert.deepEqual(edit.actions, [{ action: "edit", providerId: "beta" }]);

  const remove = setup(t);
  remove.press(TAB, UP, "d");
  assert.deepEqual(remove.actions, [{ action: "delete", providerId: "gamma" }]);

  const enter = setup(t);
  enter.press(TAB, ENTER);
  assert.deepEqual(enter.actions, [{ action: "edit", providerId: "alpha" }]);
});

test("Tab returns from rows to search and Enter there does not edit", (t) => {
  const h = setup(t);
  rows(h);
  h.press(TAB);
  assert.equal(h.list.searchFocused, true);
  h.press(ENTER);
  assert.deepEqual(h.actions, []);
});

test("filtering is case-insensitive across name, id, and method and no match performs no action", (t) => {
  const name = setup(t);
  name.paste("ALPHA");
  assert.deepEqual(name.list.visibleProviderIds(), ["alpha"]);

  const id = setup(t);
  id.paste("beta");
  assert.deepEqual(id.list.visibleProviderIds(), ["beta"]);

  const method = setup(t);
  method.paste("v1/messages");
  assert.deepEqual(method.list.visibleProviderIds(), ["beta"]);

  const none = setup(t);
  none.paste("does-not-exist");
  assert.match(none.lines().join("\n"), /No matching providers/);
  rows(none);
  assert.equal(none.list.searchFocused, true);
  none.press("d", ENTER);
  assert.deepEqual(none.actions, []);
});

test("method labels are mapped, dim styled, and model counts are shown", (t) => {
  const h = setup(t);
  const text = h.lines().join("\n");
  assert.match(text, /Alpha Provider \/v1\/responses \(3\)/);
  assert.match(text, /Beta Provider \/v1\/messages \(12\)/);
  assert.match(text, /Gamma Provider \/v1\/responses \(0\)/);
  assert.ok(h.styles.some((style) => style.startsWith("dim:/v1/responses")));
  assert.ok(h.styles.some((style) => style.startsWith("dim:/v1/messages")));
});

test("unknown native API and control characters are displayed safely", () => {
  const list = new ProviderList({
    theme: { fg: (_color, text) => text },
    refresh: () => {},
    rows: () => 24,
    done: () => {},
    providers: [
      { id: "native", name: "Native\rName", api: "custom-native", modelCount: 1, custom: false },
    ],
  });
  const lines = list.render(100).map(plain);
  assert.match(lines.join("\n"), /NativeName custom-native \(1\)/);
  assert.ok(!lines.join("\n").includes("\r"));
});

test("height and width stay bounded for Unicode and narrow terminals", () => {
  const unicode = new ProviderList({
    theme: { fg: (_color, text) => text },
    refresh: () => {},
    rows: () => 3,
    done: () => {},
    providers: [{
      id: "unicode", name: "日本語プロバイダー🎉", api: "openai-responses", modelCount: 999, custom: true,
    }],
  });
  unicode.focused = true;
  for (const width of [0, 1, 2, 3, 8, 20, 100]) {
    const lines = unicode.render(width);
    assert.ok(lines.length <= 3, `height overflow at width ${width}`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width overflow at ${width}`);
  }
});

test("render and action state remain bounded while the row focus changes", (t) => {
  const h = setup(t, 1);
  rows(h);
  h.press(DOWN);
  assert.equal(h.list.focusedProviderId, "beta");
  const lines = h.list.render(20);
  assert.equal(lines.length, 1);
  for (const line of lines) assert.ok(visibleWidth(line) <= 20);
});

test("escape exits from either focus area", (t) => {
  const search = setup(t);
  search.paste("alpha");
  search.press(ESC);
  assert.deepEqual(search.actions, [undefined]);

  const row = setup(t);
  rows(row);
  row.press(ESC);
  assert.deepEqual(row.actions, [undefined]);
});
