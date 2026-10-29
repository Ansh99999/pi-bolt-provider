import type { Method, Skin } from "./types.ts";

const CLAUDE_CODE_VERSION = "2.1.310";
const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION}`;
const CODEX_VERSION = "0.165.0";
const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_VERSION}`;
const OPENCODE_CLIENT = "opencode";

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

const MANAGED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "api-key",
  "x-api-key",
  "x-goog-api-key",
  "content-length",
  "host",
  "connection",
  "transfer-encoding",
]);

export interface SkinOption {
  readonly id: Skin;
  readonly label: string;
  readonly description: string;
}

const PI_SKIN: SkinOption = Object.freeze({
  id: "pi",
  label: "Pi-Bolt default",
  description: "No profile headers; keep Pi's native identity.",
});

const CLAUDE_CODE_SKIN: SkinOption = Object.freeze({
  id: "claude-code",
  label: "Claude Code",
  description: "Claude Code 2.1.310 branding.",
});

const CODEX_SKIN: SkinOption = Object.freeze({
  id: "codex",
  label: "Codex",
  description: "Codex CLI 0.165.0 branding.",
});

const OPENCODE_SKIN: SkinOption = Object.freeze({
  id: "opencode",
  label: "OpenCode",
  description: "OpenCode client identity for OpenCode-compatible endpoints.",
});

export const SKINS: readonly SkinOption[] = Object.freeze([
  PI_SKIN,
  CLAUDE_CODE_SKIN,
  CODEX_SKIN,
  OPENCODE_SKIN,
]);

export function profileHeaders(skin: Skin, method: Method): Record<string, string> {
  switch (skin) {
    case "pi":
      return {};
    case "claude-code":
      return {
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        ...(method === "messages" ? { "x-app": "cli" } : {}),
      };
    case "codex":
      return { "User-Agent": CODEX_USER_AGENT };
    case "opencode":
      return { "x-opencode-client": OPENCODE_CLIENT };
    default:
      throw new Error(`Unknown skin: ${String(skin)}`);
  }
}

export function validateHeader(name: string, value: string): void {
  if (typeof name !== "string" || typeof value !== "string") {
    throw new TypeError("Header name and value must be strings.");
  }

  if (!HEADER_NAME.test(name)) {
    throw new Error("Invalid header name.");
  }

  if (MANAGED_HEADERS.has(name.toLowerCase())) {
    throw new Error(`Header is managed by Pi-Bolt or the transport: ${name}`);
  }

  if (!HEADER_VALUE.test(value)) {
    throw new Error(`Invalid value for header: ${name}`);
  }
}

export function literalConfigValue(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("Config value must be a string.");
  }

  const escapedDollars = value.replace(/\$/g, () => "$$");
  return escapedDollars.startsWith("!") ? `$!${escapedDollars.slice(1)}` : escapedDollars;
}
