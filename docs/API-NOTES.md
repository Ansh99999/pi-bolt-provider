# Verified API notes

- Pi-Bolt 1.0.7 bundles Pi 1.4.0; development packages are pinned to 1.4.0.
- Extensions run through the host jiti loader. A type-only import disappears at runtime; an async import inside the slash-command handler defers the form and network helpers.
- ctx.modelRegistry.refresh({allowNetwork:false}) reloads models.json and authentication availability without fetching provider catalogs. Await it before find/getAll.
- AuthStorage is internal and is NOT exported by the public Pi 1.4.0 package. Provider settings belong in models.json; credentials in auth.json as {type:"api_key",key:...}. Native auth uses a .lock directory beside auth.json.
- Pi resolves $NAME, ${NAME} and !command in credential/header configuration. User-entered literal strings must escape $ as $$ and initial ! as $!.
- OpenAI bases contain /v1; Anthropic's SDK appends /v1/messages to its base; Google SDK uses a base containing the API version and appends /models/{id}:streamGenerateContent.
- Input from pi-tui has getValue/setValue/onSubmit/onEscape and focus support, but no password mode. The form must mask its display.
- The user requested no new background worker processes. Visible GLM subagents return files/check requests, which the orchestrator executes and feeds back.

These notes reflect inspected installed declarations and source, not guesses.
