import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { displayProviderName, normalizeEndpoint, providerId } from "./endpoints.ts";
import { literalConfigValue, profileHeaders, validateHeader } from "./headers.ts";
import { validateThinkingLevelMap } from "./thinking.ts";
import type {
  Method,
  ProviderDraft,
  ProviderModel,
  ProviderSummary,
  SaveResult,
  Skin,
  ThinkingLevelMap,
} from "./types.ts";

type Document = Record<string, unknown>;
type Snapshot = { data: Document; raw?: string };
const filenames = ["auth.json", "models.json", "provider-adder.json", "settings.json"] as const;
const reservedProviderIds = new Set(["__proto__", "prototype", "constructor"]);
const methods: readonly Method[] = ["responses", "messages", "chat", "generative"];
const skins: readonly Skin[] = ["pi", "claude-code", "codex", "opencode"];
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
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function lock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 4000;
  for (;;) {
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

function safeProviderId(id: string): string {
  if (id !== id.trim() || id.length > 64 || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id) || reservedProviderIds.has(id)) {
    throw new Error("Invalid provider ID.");
  }
  return id;
}

function thinkingMap(value: unknown): ThinkingLevelMap | undefined {
  return validateThinkingLevelMap(value);
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
  const map = thinkingMap(model.thinkingLevelMap);
  if (model.input !== undefined && (!Array.isArray(model.input) || !model.input.length || model.input.some((value) => value !== "text" && value !== "image"))) {
    throw new Error("Invalid model input types.");
  }
  return {
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    contextWindow,
    maxTokens,
    reasoning: model.reasoning ?? false,
    ...(map ? { thinkingLevelMap: map } : {}),
    input: [...new Set<"text" | "image">(model.input ?? ["text"])],
  };
}

function modelRows(value: unknown, fallback: ProviderModel[] = []): ProviderModel[] {
  if (!Array.isArray(value)) return fallback;
  const rows = value.map((row) => validateModel(row as ProviderModel));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("The model list contains a duplicate ID.");
  return rows;
}

function validNativeAuth(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.type === "api_key") {
    const key = value.key;
    const env = value.env;
    return (key === undefined || typeof key === "string") &&
      (env === undefined || (record(env) && Object.values(env).every((entry) => typeof entry === "string")));
  }
  if (value.type !== "oauth") return false;
  return typeof value.access === "string" && typeof value.refresh === "string" &&
    typeof value.expires === "number" && Number.isFinite(value.expires);
}

function methodFromApi(api: unknown): Method {
  switch (api) {
    case "anthropic-messages": return "messages";
    case "openai-completions": return "chat";
    case "google-generative-ai": return "generative";
    default: return "responses";
  }
}

function withoutKeys<T extends Document>(value: T, keys: readonly string[]): Document {
  const result: Document = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!keys.includes(key)) result[key] = entry;
  }
  return result;
}

function settingsScope(settings: Document): string[] | undefined {
  if (!own(settings, "enabledModels")) return undefined;
  const value = settings.enabledModels;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("settings.json has an invalid model scope.");
  return value;
}

function exactScopeForProvider(scope: readonly string[], id: string): string[] {
  const prefix = `${id}/`;
  const result: string[] = [];
  for (const reference of scope) {
    if (!reference.startsWith(prefix) || reference.includes("?") || reference.includes("*")) continue;
    const modelId = reference.slice(prefix.length).split(":", 1)[0];
    if (modelId && !result.includes(modelId)) result.push(modelId);
  }
  return result;
}

function selectedModelRefs(id: string, selectedIds: readonly string[]): string[] {
  return selectedIds.map((modelId) => `${id}/${modelId}`);
}

function publicUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return undefined; }
}

function metadataModels(provider: Document | undefined): ProviderModel[] {
  if (!provider || !own(provider, "models")) return [];
  return modelRows(provider.models);
}

function modelConfigRows(provider: Document | undefined): ProviderModel[] {
  if (!provider || !own(provider, "models")) return [];
  return modelRows(provider.models);
}

function knownModelFields(availableModels: readonly ProviderModel[]): { baseUrl?: string; api?: string } {
  for (const model of availableModels) {
    const structural = model as ProviderModel & { baseUrl?: unknown; api?: unknown };
    if (typeof structural.baseUrl === "string" || typeof structural.api === "string") {
      return {
        ...(typeof structural.baseUrl === "string" ? { baseUrl: structural.baseUrl } : {}),
        ...(typeof structural.api === "string" ? { api: structural.api } : {}),
      };
    }
  }
  return {};
}

function textProperty(provider: Document | undefined, key: string): string | undefined {
  const value = provider?.[key];
  return typeof value === "string" ? value : undefined;
}

function methodProperty(provider: Document | undefined): Method | undefined {
  const value = provider?.method;
  return typeof value === "string" && methods.includes(value as Method) ? value as Method : undefined;
}

function skinProperty(provider: Document | undefined): Skin | undefined {
  const value = provider?.skin;
  return typeof value === "string" && skins.includes(value as Skin) ? value as Skin : undefined;
}

function headersProperty(provider: Document | undefined): Record<string, string> {
  const value = provider?.headers;
  if (!own(provider ?? {}, "headers") || !record(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") result[key] = entry;
  return result;
}

function keysProperty(provider: Document | undefined): { keys: string[]; selectedKey: number } {
  const value = provider?.keys;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return { keys: [], selectedKey: 0 };
  const selected = provider?.selectedKey;
  return { keys: value, selectedKey: typeof selected === "number" && Number.isInteger(selected) && selected >= 0 && selected < value.length ? selected : 0 };
}

function selectedIdsProperty(provider: Document | undefined, models: readonly ProviderModel[]): string[] {
  const available = new Set(models.map((model) => model.id));
  const value = provider?.selectedModelIds;
  if (!Array.isArray(value)) return models.map((model) => model.id);
  const selected = value.filter((entry): entry is string => typeof entry === "string" && available.has(entry));
  return selected.length ? selected : models.map((model) => model.id);
}

export async function saveProvider(
  draft: ProviderDraft,
  reservedIds: readonly string[] = [],
  agentDir = getStorageDir(),
  scopeBase?: readonly string[],
): Promise<SaveResult> {
  if (!draft || typeof draft.name !== "string" || !safeText(draft.name) || typeof draft.baseUrl !== "string") throw new Error("Invalid provider details.");
  if (draft.preserveConnection !== undefined && typeof draft.preserveConnection !== "boolean") throw new Error("Invalid connection setting.");
  if (draft.editingId !== undefined && (typeof draft.editingId !== "string" || !draft.editingId)) throw new Error("Invalid provider ID.");
  const preserveConnection = draft.preserveConnection === true;
  const editing = draft.editingId !== undefined;
  if (preserveConnection && !editing) throw new Error("An existing connection can only be preserved while editing a provider.");
  const endpoint = normalizeEndpoint(draft.baseUrl, draft.method);
  const id = editing ? safeProviderId(draft.editingId!) : providerId(draft.name, draft.baseUrl);
  const name = displayProviderName(draft.name, draft.baseUrl);
  if (!editing && reservedIds.includes(id)) throw new Error(`The provider name “${name}” is already used. Go back and choose another name.`);

  let keys: string[] = [];
  if (!preserveConnection) {
    if (!Array.isArray(draft.keys) || !draft.keys.length || !Number.isInteger(draft.selectedKey) || draft.selectedKey < 0 || draft.selectedKey >= draft.keys.length) {
      throw new Error("Add and select an API key first.");
    }
    keys = draft.keys.map((key) => {
      if (typeof key !== "string" || !key.trim() || key.trim().length > 16384 || !/^[\x21-\x7e]+$/.test(key.trim())) {
        throw new Error("API keys must contain visible characters without spaces or line breaks.");
      }
      return key.trim();
    });
    if (new Set(keys).size !== keys.length) throw new Error("The same API key is listed more than once.");
  }

  if (!Array.isArray(draft.models) || draft.models.length > 5000 || !Array.isArray(draft.selectedModelIds) || !draft.selectedModelIds.length) {
    throw new Error("Choose at least one model to save.");
  }
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

  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const releases: (() => Promise<void>)[] = [];
  const written: string[] = [];
  const snapshots = new Map<string, Snapshot>();
  try {
    for (const filename of filenames) releases.push(await lock(join(agentDir, `${filename}.lock`)));
    for (const filename of filenames) snapshots.set(filename, await snapshot(join(agentDir, filename)));
    const auth = snapshots.get("auth.json")!.data;
    const modelConfig = snapshots.get("models.json")!.data;
    const metadata = snapshots.get("provider-adder.json")!.data;
    const settings = snapshots.get("settings.json")!.data;
    const modelProviders = providers(modelConfig, "models.json");
    const metadataProviders = providers(metadata, "provider-adder.json");
    const existingAuth = own(auth, id);
    const existingModels = own(modelProviders, id);
    const existingMetadata = own(metadataProviders, id);
    if (editing && !(existingAuth || existingModels || existingMetadata)) throw new Error("The provider being edited no longer exists.");
    if (!editing && (existingModels || existingAuth || existingMetadata)) {
      throw new Error(`The provider name “${name}” is already used. Go back and choose another name.`);
    }
    if (metadata.version !== undefined && metadata.version !== 1) throw new Error("The saved provider details use an unsupported format.");
    const previousScope = settingsScope(settings);
    if (preserveConnection && !(existingAuth && validNativeAuth(auth[id]))) throw new Error("The saved native sign-in is missing or invalid.");

    const scopeSource = scopeBase ?? previousScope;
    const nextSettings: Document = { ...settings };
    let settingsChanged = scopeSource !== undefined;
    if (scopeSource !== undefined) {
      const represented = new Set(scopeSource.map((reference) => reference.split("/", 1)[0]));
      const additional = scopeBase && previousScope ? previousScope.filter((reference) => {
        const provider = reference.split("/", 1)[0];
        return reference.includes("/") && !/[?*]/.test(provider) && !represented.has(provider);
      }) : [];
      const retained = [...new Set([...scopeSource, ...additional])].filter((reference) => !reference.startsWith(`${id}/`));
      nextSettings.enabledModels = [...new Set([...retained, ...selectedModelRefs(id, selectedIds)])];
    }
    if (draft.defaultModelId) {
      nextSettings.defaultProvider = id;
      nextSettings.defaultModel = draft.defaultModelId;
      settingsChanged = true;
    } else if (editing && settings.defaultProvider === id) {
      delete nextSettings.defaultProvider;
      delete nextSettings.defaultModel;
      settingsChanged = true;
    }

    const nextModelProvider = preserveConnection
      ? (() => {
        const current = existingModels ? modelProviders[id] : undefined;
        if (existingModels && !record(current)) throw new Error("models.json has an invalid provider entry.");
        const preserved: Document = record(current) ? current : {};
        const previousOverrides = preserved.modelOverrides;
        if (previousOverrides !== undefined && !record(previousOverrides)) throw new Error("models.json has invalid model overrides.");
        const overrides: Document = { ...(previousOverrides as Document | undefined) };
        for (const model of selected) {
          const prior = record(overrides[model.id]) ? overrides[model.id] as Document : {};
          overrides[model.id] = { ...withoutKeys(prior, ["reasoning", "thinkingLevelMap"]), reasoning: model.reasoning,
            ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}) };
        }
        return { ...preserved, name, modelOverrides: overrides };
      })()
      : {
        ...(record(modelProviders[id]) ? withoutKeys(modelProviders[id], ["name", "baseUrl", "api", "authHeader", "headers", "models"]) : {}),
        name,
        baseUrl: endpoint.baseUrl,
        api: endpoint.api,
        ...((draft.method === "responses" || draft.method === "chat") ? { authHeader: true } : {}),
        ...(headers.size ? { headers: escapedHeaders } : {}),
        models: selected,
      };

    const providerMetadata: Document = {
      name,
      baseUrl: preserveConnection ? draft.baseUrl : endpoint.root,
      method: draft.method,
      skin: draft.skin,
      headers: { ...draft.headers },
      keys,
      selectedKey: preserveConnection ? 0 : draft.selectedKey,
      selectedModelIds: selectedIds,
      models: [...catalog.values()],
      editingId: id,
      preserveConnection,
      ...(draft.defaultModelId ? { defaultModelId: draft.defaultModelId } : {}),
    };

    const next: Record<string, Document> = {
      ...(preserveConnection ? {} : { "auth.json": { ...auth, [id]: { type: "api_key", key: literalConfigValue(keys[draft.selectedKey]) } } }),
      "models.json": { ...modelConfig, providers: { ...modelProviders, [id]: nextModelProvider } },
      "provider-adder.json": { ...metadata, version: 1, providers: { ...metadataProviders, [id]: providerMetadata } },
      "settings.json": nextSettings,
    };
    const encoded = Object.fromEntries(Object.entries(next).map(([filename, value]) => [filename, JSON.stringify(value, null, 2) + "\n"]));
    const filesToWrite = filenames.filter((filename) => own(next, filename) && (filename !== "settings.json" || settingsChanged));
    for (const filename of filesToWrite) {
      await atomicWrite(join(agentDir, filename), encoded[filename]);
      written.push(filename);
    }
    const enabledModels = scopeSource !== undefined
      ? nextSettings.enabledModels as string[]
      : selectedModelRefs(id, selectedIds);
    return {
      providerId: id,
      providerName: name,
      ...(draft.defaultModelId ? { defaultModelId: draft.defaultModelId } : {}),
      enabledModels,
    };
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

export async function loadSavedProviders(agentDir = getStorageDir()): Promise<ProviderSummary[]> {
  const [authSnapshot, modelSnapshot, metadataSnapshot] = await Promise.all([
    snapshot(join(agentDir, "auth.json")),
    snapshot(join(agentDir, "models.json")),
    snapshot(join(agentDir, "provider-adder.json")),
  ]);
  const auth = authSnapshot.data;
  const modelProviders = providers(modelSnapshot.data, "models.json");
  const metadata = metadataSnapshot.data;
  if (metadata.version !== undefined && metadata.version !== 1) throw new Error("provider-adder.json uses an unsupported format.");
  const metadataProviders = providers(metadata, "provider-adder.json");
  const ids = new Set<string>();
  for (const [id, value] of Object.entries(auth)) {
    if (safeProviderIdForRead(id) && validNativeAuth(value)) ids.add(id);
  }
  for (const [id, value] of Object.entries(metadataProviders)) {
    if (safeProviderIdForRead(id) && record(value)) ids.add(id);
  }
  return [...ids].map((id) => {
    const metadataProvider = own(metadataProviders, id) && record(metadataProviders[id]) ? metadataProviders[id] : undefined;
    const modelProvider = own(modelProviders, id) && record(modelProviders[id]) ? modelProviders[id] : undefined;
    const metadataRows = metadataModels(metadataProvider);
    const configRows = modelConfigRows(modelProvider);
    return {
      id,
      name: textProperty(metadataProvider, "name") ?? textProperty(modelProvider, "name") ?? id,
      baseUrl: publicUrl(modelProvider?.baseUrl),
      api: typeof modelProvider?.api === "string" ? modelProvider.api : undefined,
      modelCount: metadataRows.length || configRows.length,
      custom: metadataProvider !== undefined,
    };
  });
}

function safeProviderIdForRead(id: string): boolean {
  try { safeProviderId(id); return true; } catch { return false; }
}

export async function loadProviderDraft(
  id: string,
  availableModels: readonly ProviderModel[] = [],
  agentDir = getStorageDir(),
): Promise<ProviderDraft> {
  safeProviderId(id);
  const [authSnapshot, modelSnapshot, metadataSnapshot, settingsSnapshot] = await Promise.all([
    snapshot(join(agentDir, "auth.json")),
    snapshot(join(agentDir, "models.json")),
    snapshot(join(agentDir, "provider-adder.json")),
    snapshot(join(agentDir, "settings.json")),
  ]);
  const auth = authSnapshot.data;
  const modelProviders = providers(modelSnapshot.data, "models.json");
  const metadata = metadataSnapshot.data;
  if (metadata.version !== undefined && metadata.version !== 1) throw new Error("provider-adder.json uses an unsupported format.");
  const metadataProviders = providers(metadata, "provider-adder.json");
  const settings = settingsSnapshot.data;
  const hasAuth = own(auth, id) && validNativeAuth(auth[id]);
  const modelProvider: Document | undefined = own(modelProviders, id)
    ? (record(modelProviders[id]) ? modelProviders[id] : undefined)
    : undefined;
  if (own(modelProviders, id) && modelProvider === undefined) throw new Error("models.json has an invalid provider entry.");
  const metadataProvider: Document | undefined = own(metadataProviders, id)
    ? (record(metadataProviders[id]) ? metadataProviders[id] : undefined)
    : undefined;
  if (own(metadataProviders, id) && metadataProvider === undefined) throw new Error("provider-adder.json has an invalid provider entry.");
  if (!hasAuth && !modelProvider && !metadataProvider) throw new Error("Provider not found.");

  const preserveConnection = hasAuth && (metadataProvider?.preserveConnection === true || !metadataProvider);
  const known = knownModelFields(availableModels);
  const configBaseUrl = textProperty(modelProvider, "baseUrl");
  const configApi = textProperty(modelProvider, "api");
  const baseUrl = preserveConnection ? configBaseUrl ?? known.baseUrl ?? textProperty(metadataProvider, "baseUrl") ?? ""
    : textProperty(metadataProvider, "baseUrl") ?? configBaseUrl ?? known.baseUrl ?? "";
  const api = configApi ?? known.api;
  const inferredMethod = methodProperty(metadataProvider) ?? (api ? methodFromApi(api) : "responses");
  const allAvailableModels = modelRows(availableModels);
  let models: ProviderModel[];
  let selectedIds: string[];
  if (preserveConnection) {
    models = allAvailableModels.length ? allAvailableModels : metadataModels(metadataProvider);
    const exact = exactScopeForProvider(settingsScope(settings) ?? [], id);
    const matching = exact.filter((modelId) => models.some((model) => model.id === modelId));
    selectedIds = matching.length ? matching : models.map((model) => model.id);
  } else {
    models = metadataProvider && own(metadataProvider, "models") ? metadataModels(metadataProvider) : modelConfigRows(modelProvider);
    if (!models.length && allAvailableModels.length) models = allAvailableModels;
    selectedIds = metadataProvider ? selectedIdsProperty(metadataProvider, models) : models.map((model) => model.id);
  }
  if (!models.length) throw new Error("No model details are available for this provider.");
  const uniqueSelected = [...new Set(selectedIds)].filter((modelId) => models.some((model) => model.id === modelId));
  selectedIds = uniqueSelected.length ? uniqueSelected : models.map((model) => model.id);
  const keyDetails = preserveConnection ? { keys: [] as string[], selectedKey: 0 } : keysProperty(metadataProvider);
  const defaultModelId = (() => {
    const saved = textProperty(metadataProvider, "defaultModelId");
    if (saved && selectedIds.includes(saved)) return saved;
    if (settings.defaultProvider === id && typeof settings.defaultModel === "string" && selectedIds.includes(settings.defaultModel)) return settings.defaultModel;
    return undefined;
  })();

  return {
    name: textProperty(metadataProvider, "name") ?? textProperty(modelProvider, "name") ?? id,
    baseUrl,
    method: inferredMethod,
    keys: keyDetails.keys,
    selectedKey: keyDetails.selectedKey,
    skin: skinProperty(metadataProvider) ?? "pi",
    headers: headersProperty(metadataProvider),
    models,
    selectedModelIds: selectedIds,
    ...(defaultModelId ? { defaultModelId } : {}),
    editingId: id,
    preserveConnection,
  };
}

export async function deleteProvider(id: string, agentDir = getStorageDir()): Promise<void> {
  safeProviderId(id);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const releases: (() => Promise<void>)[] = [];
  const written: string[] = [];
  const snapshots = new Map<string, Snapshot>();
  try {
    for (const filename of filenames) releases.push(await lock(join(agentDir, `${filename}.lock`)));
    for (const filename of filenames) snapshots.set(filename, await snapshot(join(agentDir, filename)));
    const auth = snapshots.get("auth.json")!.data;
    const modelConfig = snapshots.get("models.json")!.data;
    const metadata = snapshots.get("provider-adder.json")!.data;
    if (metadata.version !== undefined && metadata.version !== 1) throw new Error("The saved provider details use an unsupported format.");
    const settings = snapshots.get("settings.json")!.data;
    const modelProviders = providers(modelConfig, "models.json");
    const metadataProviders = providers(metadata, "provider-adder.json");
    const previousScope = settingsScope(settings);
    const modelThinkingLevels = (() => {
      if (!own(settings, "modelThinkingLevels")) return undefined;
      const value = settings.modelThinkingLevels;
      if (!record(value)) throw new Error("settings.json has invalid model thinking levels.");
      return value;
    })();

    const nextAuth: Document = { ...auth };
    const authChanged = own(auth, id);
    delete nextAuth[id];
    const nextModelProviders: Document = { ...modelProviders };
    const modelsChanged = own(modelProviders, id);
    delete nextModelProviders[id];
    const nextMetadataProviders: Document = { ...metadataProviders };
    const metadataChanged = own(metadataProviders, id);
    delete nextMetadataProviders[id];

    const nextSettings: Document = { ...settings };
    let settingsChanged = false;
    if (previousScope) {
      const retained = previousScope.filter((reference) => !reference.startsWith(`${id}/`));
      if (retained.length !== previousScope.length) {
        nextSettings.enabledModels = retained;
        settingsChanged = true;
      }
    }
    if (modelThinkingLevels) {
      const prefix = `${id}/`;
      const retainedThinking = Object.fromEntries(Object.entries(modelThinkingLevels).filter(([key]) => !key.startsWith(prefix)));
      if (Object.keys(retainedThinking).length !== Object.keys(modelThinkingLevels).length) {
        nextSettings.modelThinkingLevels = retainedThinking;
        settingsChanged = true;
      }
    }
    if (settings.defaultProvider === id) {
      delete nextSettings.defaultProvider;
      delete nextSettings.defaultModel;
      settingsChanged = true;
    }

    const next: Record<string, Document> = {
      ...(authChanged ? { "auth.json": nextAuth } : {}),
      ...(modelsChanged ? { "models.json": { ...modelConfig, providers: nextModelProviders } } : {}),
      ...(metadataChanged ? { "provider-adder.json": { ...metadata, version: 1, providers: nextMetadataProviders } } : {}),
      ...(settingsChanged ? { "settings.json": nextSettings } : {}),
    };
    const encoded = Object.fromEntries(Object.entries(next).map(([filename, value]) => [filename, JSON.stringify(value, null, 2) + "\n"]));
    for (const filename of filenames) {
      if (!own(next, filename)) continue;
      await atomicWrite(join(agentDir, filename), encoded[filename]);
      written.push(filename);
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const filename of written.reverse()) {
      try {
        const previous = snapshots.get(filename)!;
        if (previous.raw === undefined) await rm(join(agentDir, filename), { force: true });
        else await atomicWrite(join(agentDir, filename), previous.raw);
      } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw new Error("Deleting failed and some settings could not be restored. Check the provider settings files before retrying.");
    if (error instanceof Error && !((error as NodeJS.ErrnoException).code)) throw error;
    throw new Error("Could not delete provider settings. Check folder permissions and try again.");
  } finally {
    for (const release of releases.reverse()) await release().catch(() => {});
  }
}
