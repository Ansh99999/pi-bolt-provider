# Project instructions

Use TypeScript, Pi's native terminal components and active theme, built-in fetch and Node filesystem APIs. Add no runtime dependencies. The extension entry point must only register /provider; lazily import the wizard from the command handler. No startup file reads, networking, timers, sockets, request hooks, model discovery, or background work.

Use log/glm-5.3 with high reasoning for delegated implementation and research. Do not add AI authorship or coauthor footers. Keep API keys masked, out of logs, out of git, and in user-only local files. Tests use temporary directories, dummy keys, and local HTTP servers.

Preserve unrelated Pi configuration. Only a final explicit confirmation may save changes. Escape must preserve the draft while going back. Do not replace Pi's streaming implementations or add a proxy.

Read docs/CONTRACT.md before editing. Each worker edits only its assigned files. Do not commit, push, install the extension globally, modify the user's Pi settings, read credentials, or start another agent. Report files changed and checks run.
