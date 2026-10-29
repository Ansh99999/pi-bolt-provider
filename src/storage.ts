import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { displayProviderName, normalizeEndpoint, providerId } from "./endpoints.ts";
import { literalConfigValue, profileHeaders, validateHeader } from "./headers.ts";
import type { ProviderDraft, ProviderModel, ProviderSummary, SaveResult } from "./types.ts";

type Document = Record<string, unknown>;
type Snapshot = { data: Document; raw?: string };
const filenames = ["auth.json", "models.json", "provider-adder.json", "settings.json"] as const;
const own = (object: object, key: PropertyKey) => Object.hasOwn(object, key);
const record = (value: unknown): value is Document => value !== null && typeof value === "object" && !Array.isArray(value);
const safeText = (value: string) => !/[\u0000-\u001f\u007f-\u009f]/.test(value);

export function getStorageDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  return resolve(configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured);
}

async function snapshot(path: string): Promise<Snapshot> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { data: {} };
    throw new Error(`Could not read ${basename(path)}.`);
  }
  if (raw.length > 8 * 1024 * 1024) throw new Error(`${basename(path)} is too large to edit safely.`);
  let value: unknown;
  try { value = JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch { throw new Error(`${basename(path)} contains invalid JSON. Fix that file before saving.`); }
  if (!record(value)) throw new Error(`${basename(path)} must contain a JSON object.`);
  return { data: value, raw };
}

function providers(document: Document, filename: string): Document {
  if (!own(document, "providers")) return {};
  if (!record(document.providers)) throw new Error(`${filename} has an invalid providers list.`);
  return document.providers;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

async function lock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 4000;
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      return () => rm(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Could not lock the provider settings.");
      if (Date.now() >= deadline) throw new Error("Provider settings are busy. Try saving again shortly.");
      await delay(30);
    }
  }
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive whole number.`);
  return value;
}

function validateModel(model: ProviderModel): ProviderModel {
  if (!model || typeof model.id !== "string" || !model.id.trim() || model.id !== model.id.trim() || /[\s\u007f-\u009f]/.test(model.id)) {
    throw new Error("Each model needs an ID without spaces or control characters.");
  }
  if (model.name !== undefined && (typeof model.name !== "string" || !safeText(model.name))) throw new Error("Invalid model display name.");
  const contextWindow = positive(model.contextWindow ?? 128000, "Context limit");
  const maxTokens = positive(model.maxTokens ?? Math.min(16384, contextWindow), "Output limit");
  if (maxTokens > contextWindow) throw new Error("A model's output limit cannot exceed its context limit.");
  if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") throw new Error("Invalid model thinking setting.");
  if (model.input !== undefined && (!Array.isArray(model.input) || !model.input.length || model.input.some((value) => value !== "text" && value !== "image"))) {
    throw new Error("Invalid model input types.");
  }
  return { id: model.id, ...(model.name ? { name: model.name } : {}), contextWindow, maxTokens,
    reasoning: model.reasoning ?? false, input: [...new Set<"text" | "image">(model.input ?? ["text"])] };
}

export async function saveProvider(draft: ProviderDraft, reservedIds: readonly string[] = [], agentDir = getStorageDir()): Promise<SaveResult> {
  if (!draft || typeof draft.name !== "string" || !safeText(draft.name) || typeof draft.baseUrl !== "string") throw new Error("Invalid provider details.");
  const endpoint = normalizeEndpoint(draft.baseUrl, draft.method);
  const id = providerId(draft.name, draft.baseUrl);
  const name = displayProviderName(draft.name, draft.baseUrl);
  if (reservedIds.includes(id)) throw new Error(`The provider name “${name}” is already used. Go back and choose another name.`);
  if (!Array.isArray(draft.keys) || !draft.keys.length || !Number.isInteger(draft.selectedKey) || draft.selectedKey < 0 || draft.selectedKey >= draft.keys.length) {
    throw new Error("Add and select an API key first.");
  }
  const keys = draft.keys.map((key) => {
    if (typeof key !== "string" || !key.trim() || key.trim().length > 16384 || !/^[\x21-\x7e]+$/.test(key.trim())) throw new Error("API keys must contain visible characters without spaces or line breaks.");
    return key.trim();
  });
  if (new Set(keys).size !== keys.length) throw new Error("The same API key is listed more than once.");
  if (!Array.isArray(draft.models) || draft.models.length > 5000 || !Array.isArray(draft.selectedModelIds) || !draft.selectedModelIds.length) throw new Error("Choose at least one model to save.");
  const catalog = new Map<string, ProviderModel>();
  for (const candidate of draft.models) {
    const model = validateModel(candidate);
    if (catalog.has(model.id)) throw new Error("The model list contains a duplicate ID.");
    catalog.set(model.id, model);
  }
  const selectedIds = [...new Set(draft.selectedModelIds)];
  const selected = selectedIds.map((modelId) => {
    const model = catalog.get(modelId);
    if (!model) throw new Error("A selected model is missing from the list.");
    return model;
  });
  if (draft.defaultModelId !== undefined && !selectedIds.includes(draft.defaultModelId)) throw new Error("The default model must be selected.");
  if (!record(draft.headers)) throw new Error("Invalid custom headers.");
  const headers = new Map<string, string>();
  for (const [key, value] of Object.entries(profileHeaders(draft.skin, draft.method))) headers.set(key.toLowerCase(), value);
  for (const [key, value] of Object.entries(draft.headers)) {
    if (typeof value !== "string") throw new Error("Header values must be text.");
    validateHeader(key, value);
    headers.set(key.toLowerCase(), value);
  }
  const escapedHeaders = Object.fromEntries([...headers].map(([key, value]) => [key, literalConfigValue(value)]));
  const provider = { name, baseUrl: endpoint.baseUrl, api: endpoint.api,
    ...((draft.method === "responses" || draft.method === "chat") ? { authHeader: true } : {}),
    ...(headers.size ? { headers: escapedHeaders } : {}), models: selected };

  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const releases: (() => Promise<void>)[] = [];
  const written: string[] = [];
  const snapshots = new Map<string, Snapshot>();
  try {
    // The native credential store uses this same .lock directory protocol.
    for (const filename of filenames) releases.push(await lock(join(agentDir, `${filename}.lock`)));
    for (const filename of filenames) snapshots.set(filename, await snapshot(join(agentDir, filename)));
    const auth = snapshots.get("auth.json")!.data;
    const modelConfig = snapshots.get("models.json")!.data;
    const metadata = snapshots.get("provider-adder.json")!.data;
    const settings = snapshots.get("settings.json")!.data;
    const modelProviders = providers(modelConfig, "models.json");
    const metadataProviders = providers(metadata, "provider-adder.json");
    if (own(modelProviders, id) || own(auth, id) || own(metadataProviders, id)) throw new Error(`The provider name “${name}” is already used. Go back and choose another name.`);
    if (metadata.version !== undefined && metadata.version !== 1) throw new Error("The saved provider details use an unsupported format.");
    if (settings.enabledModels !== undefined && (!Array.isArray(settings.enabledModels) || settings.enabledModels.some((value) => typeof value !== "string"))) throw new Error("settings.json has an invalid model scope.");
    const nextSettings = { ...settings };
    if (draft.defaultModelId) Object.assign(nextSettings, { defaultProvider: id, defaultModel: draft.defaultModelId });
    if (Array.isArray(settings.enabledModels) && settings.enabledModels.length) {
      nextSettings.enabledModels = [...new Set([...settings.enabledModels, ...selectedIds.map((modelId) => `${id}/${modelId}`)])];
    }
    const next: Record<string, Document> = {
      "auth.json": { ...auth, [id]: { type: "api_key", key: literalConfigValue(keys[draft.selectedKey]) } },
      "models.json": { ...modelConfig, providers: { ...modelProviders, [id]: provider } },
      "provider-adder.json": { ...metadata, version: 1, providers: { ...metadataProviders, [id]: {
        name, baseUrl: endpoint.root, method: draft.method, skin: draft.skin, headers: { ...draft.headers }, keys,
        selectedKey: draft.selectedKey, selectedModelIds: selectedIds,
        ...(draft.defaultModelId ? { defaultModelId: draft.defaultModelId } : {}),
      } } },
      "settings.json": nextSettings,
    };
    const encoded = Object.fromEntries(filenames.map((filename) => [filename, JSON.stringify(next[filename], null, 2) + "\n"]));
    for (const filename of filenames) {
      if (filename === "settings.json" && !draft.defaultModelId && !(Array.isArray(settings.enabledModels) && settings.enabledModels.length)) continue;
      await atomicWrite(join(agentDir, filename), encoded[filename]);
      written.push(filename);
    }
    return { providerId: id, providerName: name, ...(draft.defaultModelId ? { defaultModelId: draft.defaultModelId } : {}) };
  } catch (error) {
    let rollbackFailed = false;
    for (const filename of written.reverse()) {
      try {
        const previous = snapshots.get(filename)!;
        if (previous.raw === undefined) await rm(join(agentDir, filename), { force: true });
        else await atomicWrite(join(agentDir, filename), previous.raw);
      } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw new Error("Saving failed and some settings could not be restored. Check the provider settings files before retrying.");
    if (error instanceof Error && !((error as NodeJS.ErrnoException).code)) throw error;
    throw new Error("Could not save provider settings. Check folder permissions and try again.");
  } finally {
    for (const release of releases.reverse()) await release().catch(() => {});
  }
}

function publicUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
  catch { return undefined; }
}

export async function loadSavedProviders(agentDir = getStorageDir()): Promise<ProviderSummary[]> {
  const config = await snapshot(join(agentDir, "models.json"));
  return Object.entries(providers(config.data, "models.json")).map(([id, value]) => {
    const provider = record(value) ? value : {};
    return { id, name: typeof provider.name === "string" ? provider.name : id,
      baseUrl: publicUrl(provider.baseUrl), api: typeof provider.api === "string" ? provider.api : undefined,
      modelCount: Array.isArray(provider.models) ? provider.models.length : 0, custom: true };
  });
}
