export type Method = "responses" | "messages" | "chat" | "generative";
export type Skin = "pi" | "claude-code" | "codex" | "opencode";

export interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
}

export interface ProviderDraft {
  name: string;
  baseUrl: string;
  method: Method;
  keys: string[];
  selectedKey: number;
  skin: Skin;
  headers: Record<string, string>;
  models: ProviderModel[];
  selectedModelIds: string[];
  defaultModelId?: string;
}

export interface ProviderSummary {
  id: string;
  name: string;
  baseUrl?: string;
  api?: string;
  modelCount: number;
  custom: boolean;
}

export interface Endpoint {
  root: string;
  baseUrl: string;
  modelsUrl: string;
  api: "openai-responses" | "anthropic-messages" | "openai-completions" | "google-generative-ai";
}

export interface KeyCheck {
  status: "valid" | "invalid" | "unknown";
  message: string;
}

export interface SaveResult {
  providerId: string;
  providerName: string;
  defaultModelId?: string;
}

export function emptyDraft(): ProviderDraft {
  return {
    name: "", baseUrl: "", method: "responses", keys: [], selectedKey: 0,
    skin: "pi", headers: {}, models: [], selectedModelIds: [],
  };
}
