import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configuredProviders, runProviderCommand } from "../src/command.ts";

test("browser lists saved sign-ins and additions, and cancelling deletion preserves files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-provider-command-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const auth = JSON.stringify({ signed: { type: "oauth", refresh: "dummy-refresh", access: "dummy-access", expires: 123456789 } });
  await writeFile(join(dir, "auth.json"), auth);
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: {
    signed: { name: "Signed provider" }, catalogOnly: { models: [{ id: "hidden" }] },
  } }));
  await writeFile(join(dir, "provider-adder.json"), JSON.stringify({ version: 1, providers: { added: { name: "Added provider" } } }));
  const models = [
    { provider: "signed", id: "one", api: "anthropic-messages" },
    { provider: "signed", id: "two", api: "anthropic-messages" },
    { provider: "added", id: "three", api: "openai-responses" },
    { provider: "builtin", id: "hidden", api: "openai-completions" },
    { provider: "catalogOnly", id: "hidden", api: "openai-completions" },
  ];
  let browserCalls = 0;
  let confirmations = 0;
  const ctx = {
    modelRegistry: { getAll: () => models, getProviderDisplayName: (id: string) => id },
    ui: {
      select: async () => "List Providers",
      notify: () => {},
      confirm: async () => { confirmations++; return false; },
      custom: async (factory: (...args: any[]) => any) => {
        browserCalls++;
        return new Promise((resolve) => {
          const component = factory({ requestRender: () => {}, terminal: { rows: 24 } }, { fg: (_color: string, value: string) => value }, {}, resolve);
          component.focused = true;
          if (browserCalls === 1) {
            component.handleInput("\t"); component.handleInput("d");
          } else component.handleInput("\x1b");
          component.dispose?.();
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  const providers = await configuredProviders(ctx);
  assert.deepEqual(providers.map((provider) => provider.id).sort(), ["added", "signed"]);
  assert.equal(providers.find((provider) => provider.id === "signed")?.modelCount, 2);
  assert.ok(!JSON.stringify(providers).includes("dummy"));
  await runProviderCommand({} as ExtensionAPI, ctx);
  assert.equal(confirmations, 1);
  assert.equal(browserCalls, 2);
  assert.equal(await readFile(join(dir, "auth.json"), "utf8"), auth);
});
