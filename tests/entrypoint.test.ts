import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import activate from "../index.ts";

type Registration = Parameters<ExtensionAPI["registerCommand"]>[1];

function registered() {
  let command: Registration | undefined;
  const names: string[] = [];
  const api = new Proxy({}, {
    get(_target, name) {
      if (name !== "registerCommand") throw new Error(`Unexpected startup API: ${String(name)}`);
      return (name: string, options: Registration) => { names.push(name); command = options; };
    },
  }) as ExtensionAPI;
  activate(api);
  assert.deepEqual(names, ["provider"]);
  assert.ok(command);
  return command;
}

test("activation only registers the provider command", () => {
  const command = registered();
  assert.match(command.description ?? "", /provider/i);
});

test("non-terminal invocation returns before loading or opening the form", async () => {
  const command = registered();
  const notices: string[] = [];
  const context = {
    mode: "print", ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext;
  await command.handler("", context);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /terminal/i);
});

test("duplicate openings are blocked and closing the menu releases the command", async () => {
  const command = registered();
  let menuReady!: () => void;
  let closeMenu!: (value: string | undefined) => void;
  const ready = new Promise<void>((resolve) => { menuReady = resolve; });
  const menu = new Promise<string | undefined>((resolve) => { closeMenu = resolve; });
  let selections = 0;
  const notices: string[] = [];
  const context = {
    mode: "tui", model: undefined,
    ui: {
      select: () => { selections++; menuReady(); return menu; },
      notify: (message: string) => notices.push(message),
    },
  } as unknown as ExtensionCommandContext;
  const first = command.handler("", context);
  await ready;
  await command.handler("", context);
  assert.equal(selections, 1);
  assert.match(notices.at(-1)!, /already open/i);
  closeMenu(undefined);
  await first;
  await command.handler("", context);
  assert.equal(selections, 2);
});

test("menu errors release the command instead of leaving it stuck open", async () => {
  const command = registered();
  let selections = 0;
  const context = {
    mode: "tui", model: undefined,
    ui: { select: async () => { selections++; throw new Error("Dummy menu failure"); }, notify: () => {} },
  } as unknown as ExtensionCommandContext;
  await assert.rejects(command.handler("", context), /Dummy menu failure/);
  await assert.rejects(command.handler("", context), /Dummy menu failure/);
  assert.equal(selections, 2);
});
