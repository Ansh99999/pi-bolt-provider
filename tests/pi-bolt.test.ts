import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { saveProvider } from "../src/storage.ts";
import { emptyDraft } from "../src/types.ts";
import type { Method } from "../src/types.ts";

const execute = promisify(execFile);
const binary = process.env.PI_BOLT_BIN ?? "pi-bolt";
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));

test("real Pi-Bolt loads saved providers and the extension without contacting providers", async (t) => {
  try {
    await execute(binary, ["--version"], { timeout: 10000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip("Set PI_BOLT_BIN to run the native Pi-Bolt integration check.");
      return;
    }
    throw error;
  }

  const agentDir = await mkdtemp(join(tmpdir(), "provider-native-test-"));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(agentDir, { recursive: true, force: true });
  });

  const methods: Method[] = ["responses", "messages", "chat", "generative"];
  const providerIds: string[] = [];
  for (const method of methods) {
    const draft = emptyDraft();
    draft.name = `native-test-${method}`;
    draft.baseUrl = `http://127.0.0.1:${address.port}`;
    draft.method = method;
    draft.keys = ["dummy-local-key-$literal-!literal"];
    draft.models = [{ id: `native-model-${method}` }];
    draft.selectedModelIds = [draft.models[0].id];
    const result = await saveProvider(draft, [], agentDir);
    providerIds.push(result.providerId);
  }

  const result = await execute(binary, [
    "--offline", "--no-extensions", "--no-mcp", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--no-approve",
    "--extension", entry, "--list-models", "native-test",
  ], {
    cwd: agentDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  for (const providerId of providerIds) assert.ok(result.stdout.includes(providerId), result.stdout);
  for (const method of methods) assert.ok(result.stdout.includes(`native-model-${method}`), result.stdout);
  assert.doesNotMatch(result.stderr, /extension.*(?:error|fail)|failed to load/i);
  assert.equal(requests, 0, "Startup must not probe provider endpoints.");
  const models = await readFile(join(agentDir, "models.json"), "utf8");
  assert.ok(!models.includes("dummy-local-key"), "The model catalog must not contain raw keys.");
});
