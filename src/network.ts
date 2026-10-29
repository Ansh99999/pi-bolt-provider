import { normalizeEndpoint } from "./endpoints.ts";
import { profileHeaders, validateHeader } from "./headers.ts";
import { discoveredThinking } from "./thinking.ts";
import type { KeyCheck, ProviderDraft, ProviderModel } from "./types.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 5000;
const MAX_PAGES = 10;
const TIMEOUT_MS = 12000;
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

class ListError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); this.name = "ListError"; this.status = status; }
}

function requestHeaders(draft: ProviderDraft): Headers {
  const key = draft.keys[draft.selectedKey]?.trim();
  if (!key || /[^\x21-\x7e]/.test(key)) throw new ListError("Add and select a valid API key first.");
  const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
  const headers = new Headers({ accept: "application/json", "user-agent": `pi/1.4.0 (${process.platform}; ${runtime}; ${process.arch})` });
  for (const [name, value] of Object.entries(profileHeaders(draft.skin, draft.method))) headers.set(name, value);
  for (const [name, value] of Object.entries(draft.headers)) { validateHeader(name, value); headers.set(name, value); }
  if (draft.method === "messages") { headers.set("x-api-key", key); if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01"); }
  else if (draft.method === "generative") headers.set("x-goog-api-key", key);
  else headers.set("authorization", `Bearer ${key}`);
  return headers;
}

async function readJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel(); throw new ListError("The model list is too large. Add specific models manually.");
  }
  if (!response.body) throw new ListError("The server returned an empty model list response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new ListError("The model list is too large. Add specific models manually.");
      chunks.push(part.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ListError("The server did not return a readable model list. Add models manually."); }
}

function modelFromRow(row: unknown, google: boolean): ProviderModel | undefined {
  if (!object(row)) return undefined;
  if (google && Array.isArray(row.supportedGenerationMethods) && !row.supportedGenerationMethods.some((method) => method === "generateContent" || method === "streamGenerateContent")) return undefined;
  const rawId = google ? row.name ?? row.id : row.id;
  if (typeof rawId !== "string") return undefined;
  const id = google ? rawId.replace(/^models\//, "") : rawId;
  if (!id || id.length > 4096 || /[\s\u007f-\u009f]/.test(id)) return undefined;
  const rawName = row.displayName ?? row.display_name ?? row.name;
  const name = typeof rawName === "string" ? rawName.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 200) : undefined;
  const contextWindow = integer(row.contextWindow ?? row.context_window ?? row.inputTokenLimit ?? row.context_length);
  const maxTokens = integer(row.maxTokens ?? row.max_output_tokens ?? row.outputTokenLimit ?? row.max_completion_tokens);
  const input = Array.isArray(row.input_modalities) ? row.input_modalities.filter((item): item is "text" | "image" => item === "text" || item === "image") : undefined;
  const thinking = discoveredThinking(row);
  return { id, ...(name && name !== id ? { name } : {}), ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens && (!contextWindow || maxTokens <= contextWindow) ? { maxTokens } : {}),
    ...thinking, ...(input?.length ? { input: [...new Set(input)] } : {}) };
}

export async function fetchModels(draft: ProviderDraft, signal?: AbortSignal): Promise<ProviderModel[]> {
  const endpoint = normalizeEndpoint(draft.baseUrl, draft.method);
  const headers = requestHeaders(draft);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, TIMEOUT_MS);
  const url = new URL(endpoint.modelsUrl);
  if (draft.method === "messages") url.searchParams.set("limit", "1000");
  if (draft.method === "generative") url.searchParams.set("pageSize", "1000");
  const models = new Map<string, ProviderModel>();
  const pageTokens = new Set<string>();
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetch(url, { headers, signal: controller.signal, redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ListError(response.status === 404 || response.status === 405
          ? "This server does not offer a model list here. Add models manually."
          : `The model list request failed (HTTP ${response.status}).`, response.status);
      }
      const data = await readJson(response);
      const rows = Array.isArray(data) ? data : object(data) ? data.data ?? data.models : undefined;
      if (!Array.isArray(rows)) throw new ListError("The server returned an unsupported model list. Add models manually.");
      if (rows.length > MAX_MODELS) throw new ListError("The model list is too large. Add specific models manually.");
      for (const row of rows) {
        const model = modelFromRow(row, draft.method === "generative");
        if (model) models.set(model.id, model);
        if (models.size > MAX_MODELS) throw new ListError("The model list is too large. Add specific models manually.");
      }
      let token: string | undefined;
      if (object(data) && draft.method === "generative" && typeof data.nextPageToken === "string" && data.nextPageToken) {
        token = data.nextPageToken; url.searchParams.set("pageToken", token);
      } else if (object(data) && draft.method === "messages" && data.has_more === true) {
        const last = rows.at(-1);
        const lastId = data.last_id ?? (object(last) ? last.id : undefined);
        if (typeof lastId !== "string" || !lastId) throw new ListError("The server returned incomplete model pages. Add models manually.");
        token = lastId; url.searchParams.set("after_id", token);
      }
      if (!token) return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
      if (pageTokens.has(token)) throw new ListError("The server repeated a model page. Add models manually.");
      pageTokens.add(token);
    }
    throw new ListError("The model list has too many pages. Add specific models manually.");
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (controller.signal.aborted) throw new ListError("The model request timed out. You can retry or add models manually.");
    if (error instanceof ListError) throw error;
    throw new ListError("Could not reach the model list. Check the address and connection, or add models manually.");
  } finally {
    clearTimeout(timeout); signal?.removeEventListener("abort", abort);
  }
}

export async function checkKey(draft: ProviderDraft, signal?: AbortSignal): Promise<KeyCheck> {
  try {
    const models = await fetchModels(draft, signal);
    return models.length ? { status: "valid", message: "The server accepted this key for model listing." }
      : { status: "unknown", message: "The server returned no models, so the key could not be fully checked." };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof ListError && error.status === 401) return { status: "invalid", message: "The server rejected this key (HTTP 401)." };
    if (error instanceof ListError && error.status === 403) return { status: "unknown", message: "Access denied (HTTP 403). This key may lack permission." };
    return { status: "unknown", message: error instanceof ListError ? error.message : "The key could not be checked. Check the provider details." };
  }
}
