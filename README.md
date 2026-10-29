# Pi-Bolt Provider

Pi-Bolt Provider is a Pi extension for adding custom model providers and selecting a global default model. It uses Pi's native terminal components and active theme, with a `/provider` command after installation (registered as Pi command `provider`).

## Install

From the published repository:

```sh
pi-bolt install git:github.com/Ansh99999/pi-bolt-provider
pi-bolt compile
```

From a local checkout:

```sh
pi-bolt -e ./index.ts
```

A private repository requires the installing user to have authorized GitHub access to that repository.

The compile step uses Pi-Bolt's own compiler to include installed extensions in its executable. This avoids its source-extension loader at startup. The first compile downloads Pi-Bolt's runtime and compile kit (about 52 MB on Linux); later builds reuse that cache. Source loading with `-e` is useful during development.

## What it does

- Adds a provider through a native terminal wizard: name, base URL, protocol, API keys, client skin/headers, models, and review.
- Saves selected models to Pi's native model configuration and stores the active key in Pi's native auth store.
- Sets a chosen global default provider and model after refresh.
- Lists registered providers and shows the current provider, model, and base URL without displaying secrets.

Network access occurs only when you fetch models or check a key. Requests have a timeout and can be cancelled. The extension starts no background work, watchers, proxy, or request hooks while Pi starts or handles normal prompts.

The entry point registers only the provider command. Command implementation and wizard code are lazily imported when the command is used, keeping startup limited to a small fixed registration cost. There are zero runtime dependencies; the implementation is TypeScript using Pi's native APIs and built-in Node APIs.

## API keys and local files

Keys are entered through masked input and stored in Pi's native `auth.json` format. Additional key material and provider metadata are stored in `provider-adder.json` in the agent directory, normally `~/.pi/agent` unless `PI_CODING_AGENT_DIR` is set.

Saved files use `0600` permissions; newly created folders use `0700`. All entered keys stay in `provider-adder.json`; the selected key is also saved in `auth.json`. Keys are not encrypted at rest. The extension does not print or log API keys. Keys are not rotated automatically.

## Controls

Run `/provider` to see:

```text
Current provider: the provider of your current model
Add provider
List Providers
```

The form follows Name → Base URL → Method → API keys → Header / Skin → Models → Review. `Enter` advances and `Esc` returns with your entries retained. Nothing is saved until the final confirmation. Leave the name blank to use the host name. An address such as `example.com` gets `https://` automatically, and a pasted `/v1` is handled for the selected method.

| Screen | Controls |
|---|---|
| API keys | Arrows choose the active key; `N` adds; `D` deletes; `Ctrl+K` checks it. |
| Header / Skin | Arrows highlight a skin; `Space` selects it; `N` adds a custom header; `D` deletes a highlighted custom header; `Enter` advances. |
| Models | `Space` fetches; arrows and Page Up/Down move; `A` selects or removes one; `N` adds a manual model. |
| Model selection | `Ctrl+A` selects all; `Ctrl+E` clears the selection; `Ctrl+D` marks the highlighted model as the harness default. |
| Save selection | `Ctrl+S` or `Enter` moves to review; a separate `Enter` on Review confirms and saves. |

If a provider cannot list models, enter their IDs with `N`. A failed key check can mean that listing is unsupported; it does not automatically mean the key is invalid. A successful list check verifies model-list access, not every model's generation permissions.

## Google routes and labels

The wizard's `generativecontent` label is a protocol choice, not an endpoint URL. Google requests use Pi's native `google-generative-ai` route. With an explicit Google base, the model route is `/models/{model}:streamGenerateContent`; the base URL identifies the selected native version such as `/v1beta` or `/v1`. No invented `/generativecontent` endpoint is saved.

## Configuration preservation

Saving a provider merges selected models into Pi's native configuration and preserves unrelated models, credentials, and settings. If a global model scope already exists, newly saved models are appended without removing other providers. Existing project or CLI settings can still override the global default.

After confirmation, a marked default is saved for future sessions and selected in the current session when Pi can load it. Existing project or command-line settings can override the global default in future sessions. Adding a provider without marking a default keeps the current model.

Manual model entries default to a `128000` token context window and `16384` output tokens. Both values can be edited, and output tokens must not exceed the context window. You can also set thinking and image support.

## Client skins

Provider skins supply verified static headers for Pi, Claude Code, Codex CLI, and OpenCode. They do not invent account, session, organization, or bearer values. Custom headers can override documented skin values. See [docs/header-profiles.md](docs/header-profiles.md) for the profile details and source citations.

Security-sensitive headers remain managed by the selected API key. Custom header names and values are validated, and Pi interpolation is escaped so literal strings do not execute commands.

## Limits and assumptions

See [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md). Provider capabilities depend on the server. See [startup measurements](docs/performance.md) for the source and compiled loading paths.

Run the project checks with:

```sh
npm run check
npm test
```

## License

MIT © 2026 Ansh Raj
