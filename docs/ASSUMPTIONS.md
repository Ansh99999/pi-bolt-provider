# Assumptions

These choices fill gaps in the request. They can be changed.

- The new GitHub repository is private because no visibility was specified.
- When several keys are saved, the selected key is used. Keys do not rotate automatically.
- Escape goes back and retains entered details. Enter advances. Saving happens only after final confirmation.
- On the models page, Ctrl+A selects all models, A selects or removes the highlighted model, Ctrl+E clears the choices, and Ctrl+S moves to review.
- Ctrl+D marks the harness-wide default. It takes effect only after confirmation, for the current session and future sessions that use the global settings.
- List Providers includes both built-in providers and added providers.
- Skins change client headers. They do not sign into another app or give access to its subscription.
- Checks use temporary settings and made-up keys.
- An explicitly entered http:// address is kept, which allows local servers. Addresses without a scheme use https://.
- Extra keys stay on this machine in a file restricted to your user account. They are not encrypted by the extension.
- Adding a provider with an existing name asks for a different name rather than replacing the old provider.
- Models chosen in this wizard are the models saved for the new provider. Existing choices for other providers are kept.
- If a server does not offer a model list, you can add model names manually. A missing model list alone does not mean the key is wrong.
- Google uses its actual model-specific generate-content route. The requested /v1/generativecontent choice names that method; it is not a separate endpoint that Pi supports.

- GLM remains the worker model. Because visible GLM subagents cannot receive shell tools in this running session, they prepare changes and request checks; the orchestrator runs those operations and returns the results. No more hidden background workers are used.
- Skin presets use fixed, checked app versions and do not check for new versions when Pi starts. Their headers can be overridden in the form.
- Manual models start with Pi's usual limits: 128000 context tokens and 16384 output tokens. The form lets you edit them and choose thinking/image support.
- Custom header values are hidden while typing. Non-secret header values are visible during review; keys and secret-like values remain hidden.
- For the lowest startup cost, the recommended install includes Pi-Bolt's own compile step. Source loading remains available for development and has the harness's normal loader cost.
- Commits use your GitHub name and private GitHub email address, with no AI authorship footers.
- The repository uses the MIT license, matching Pi-Bolt.
