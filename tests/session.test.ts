import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  resolveModelScopeWithDiagnostics, SessionManager,
  type ExtensionAPI, type ExtensionCommandContext, type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { applySavedChanges, scopeForSave } from "../src/session.ts";
import { saveProvider, loadProviderDraft, deleteProvider } from "../src/storage.ts";
import { emptyDraft } from "../src/types.ts";

test("scope snapshot keeps session choices and disconnected saved choices", () => {
  const model = { provider: "other", id: "chosen" };
  const ctx = { scopedModels: [{ model, thinkingLevel: "high" }], modelRegistry: { getAvailable: () => [model, { provider: "other", id: "disabled" }] } } as unknown as ExtensionCommandContext;
  const pi = { getSettings: () => ({ enabledModels: ["other/*", "offline/*", "*"] }) } as unknown as ExtensionAPI;
  assert.deepEqual(scopeForSave(pi, ctx), ["other/chosen:high", "offline/*"]);
});

test("saved choices and thinking levels apply when resuming the same real Pi conversation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-provider-session-"));
  const agentDir = join(dir, "agent");
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(500).end(); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const first = { ...emptyDraft(), name: "first", baseUrl, keys: ["dummy-first"], models: [{ id: "old" }, { id: "chosen" }], selectedModelIds: ["old"] };
  const other = { ...emptyDraft(), name: "other", baseUrl, keys: ["dummy-other"], models: [{ id: "keep" }], selectedModelIds: ["keep"] };
  await saveProvider(first, [], agentDir, []);
  await saveProvider(other, [], agentDir, ["first/old"]);
  const factory: CreateAgentSessionRuntimeFactory = async (options) => {
    const services = await createAgentSessionServices({
      cwd: options.cwd, agentDir: options.agentDir,
      resourceLoaderOptions: {
        noExtensions: true, disabledBuiltinExtensions: ["mcp"], noSkills: true,
        noPromptTemplates: true, noThemes: true, noContextFiles: true,
      },
    });
    const patterns = services.settingsManager.getEnabledModels();
    const resolved = patterns?.length ? await resolveModelScopeWithDiagnostics(patterns, services.modelRuntime) : undefined;
    const result = await createAgentSessionFromServices({ services, sessionManager: options.sessionManager,
      sessionStartEvent: options.sessionStartEvent, scopedModels: resolved?.scopedModels, noTools: "all" });
    return { ...result, services, diagnostics: [] };
  };
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendMessage({ role: "user", content: "Keep this conversation.", timestamp: Date.now() });
  const host = await createAgentSessionRuntime(factory, { cwd: dir, agentDir, sessionManager: manager });
  t.after(() => host.dispose());
  const sessionFile = host.session.sessionFile;
  const sessionId = host.session.sessionId;
  const notifications: string[] = [];
  const pi = {
    getSettings: () => host.session.settingsManager.getSettings(),
    setModel: async (model: Parameters<typeof host.session.setModel>[0]) => { await host.session.setModel(model); return true; },
  } as unknown as ExtensionAPI;
  const context = (): ExtensionCommandContext => ({
    modelRegistry: host.session.createReplacedSessionContext().modelRegistry,
    model: host.session.model, scopedModels: host.session.scopedModels,
    sessionManager: host.session.sessionManager,
    ui: { notify: (message: string) => { notifications.push(message); } },
    switchSession: (path: string, options: Parameters<ExtensionCommandContext["switchSession"]>[1]) => host.switchSession(path, options),
  }) as unknown as ExtensionCommandContext;
  // Use the actual registry facade; it is intentionally public through native contexts.
  const nativeContext = host.session.createReplacedSessionContext();
  const ctx = context();
  Object.assign(ctx, { modelRegistry: nativeContext.modelRegistry });
  const draft = await loadProviderDraft("first", [], agentDir);
  draft.selectedModelIds = ["chosen"];
  draft.models.find((model) => model.id === "chosen")!.reasoning = true;
  draft.models.find((model) => model.id === "chosen")!.thinkingLevelMap = { minimal: null, xhigh: "xhigh", max: "max" };
  draft.defaultModelId = "chosen";
  const saved = await saveProvider(draft, ["first", "other"], agentDir, scopeForSave(pi, ctx));
  await applySavedChanges(pi, ctx, saved);
  assert.equal(host.session.sessionFile, sessionFile);
  assert.equal(host.session.sessionId, sessionId);
  assert.deepEqual(host.session.scopedModels.map(({ model }) => `${model.provider}/${model.id}`).sort(), ["first/chosen", "other/keep"]);
  assert.equal(host.session.model?.id, "chosen");
  assert.deepEqual(host.session.getAvailableThinkingLevels(), ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(host.session.messages.filter((message) => message.role === "user").length, 1);
  assert.ok((await readFile(sessionFile!, "utf8")).includes("Keep this conversation."));
  assert.equal(requests, 0, "Applying choices must not contact provider endpoints.");

  await deleteProvider("first", agentDir);
  const deleteCtx = context();
  Object.assign(deleteCtx, { modelRegistry: host.session.createReplacedSessionContext().modelRegistry });
  await applySavedChanges(pi, deleteCtx, undefined, "first");
  assert.equal(host.session.model?.provider, "other");
  assert.deepEqual(host.session.scopedModels.map(({ model }) => `${model.provider}/${model.id}`), ["other/keep"]);
  assert.equal(host.session.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(requests, 0);
});
