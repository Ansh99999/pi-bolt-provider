# Header profiles

Pi-Bolt header profiles carry only stable, public client branding. They never carry account, session, organization, bearer-token, API-key, request-body, or transport-framing details. The selected API key remains the only authentication source.

## Profiles

| Skin | Headers | Method scope |
|---|---|---|
| `pi` | None | All |
| `claude-code` | `User-Agent: claude-cli/2.1.310`; `x-app: cli` on Anthropic Messages | User-Agent on all methods; `x-app` only on `messages` |
| `codex` | `User-Agent: codex_cli_rs/0.165.0` | All |
| `opencode` | `x-opencode-client: opencode` | All |

A selected skin always supplies its public branding header. Protocol-specific headers are added only when the selected method matches the protocol that uses them, so a skin is never silently inactive on another method.

`profileHeaders()` returns a fresh object. Custom headers should be merged after profile headers so user overrides win.

## Source evidence and limits

- **Pi 1.4.0**: [Pi identity](https://github.com/opensec-git/Pi-Bolt/blob/pi-bolt/packages/ai/src/utils/identity.ts) and [Anthropic Messages client](https://github.com/opensec-git/Pi-Bolt/blob/pi-bolt/packages/ai/src/api/anthropic-messages.ts). The `pi` profile returns no headers, leaving Pi's native identity unchanged.
- **Claude Code 2.1.310**: [Claude Code package](https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.310). The installed build and Pi's Anthropic client confirm `claude-cli/2.1.310` and `x-app: cli` for Messages. The profile does not reproduce OAuth, API-key, beta, account, organization, or session details.
- **Codex CLI 0.165.0**: [Codex repository](https://github.com/openai/codex). The installed binary contains the product token `codex_cli_rs`, and `codex --version` reports `codex-cli 0.165.0`. The profile uses the verified product/version pair. It does not invent an `originator` value because the supplied evidence does not establish the exact outbound header.
- **OpenCode**: [OpenCode repository](https://github.com/sst/opencode). Pi sends `x-opencode-client` for OpenCode-compatible targets. This extension does not generate `x-opencode-session` because it has no per-conversation session ID or request hook.

## Validation rules

`validateHeader()` accepts RFC 7230 header-name tokens, including the backtick character, and printable ASCII values with tabs. It rejects invalid names, control characters, non-ASCII values, and headers that must remain transport-managed or authentication-owned:

- `Authorization`
- `Proxy-Authorization`
- `Api-Key`
- `X-Api-Key`
- `X-Goog-Api-Key`
- `Content-Length`
- `Host`
- `Connection`
- `Transfer-Encoding`

Errors include the header name but never the value.

## Pi config escaping

`literalConfigValue()` escapes every `$` as `$$` and an initial `!` as `$!`. Pi's native resolver decodes `$$` to a literal dollar and `$!` to a literal exclamation mark after command detection.

Examples:

- `!command` becomes `$!command`
- `$HOME` becomes `$$HOME`
- `!$HOME` becomes `$!$$HOME`
