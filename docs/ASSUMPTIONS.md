# Assumptions

These choices fill gaps in the request. They can be changed.

- The new GitHub repository is private because no visibility was specified.
- When several keys are saved, the selected key is used. Keys do not rotate automatically.
- Escape goes back and retains entered details. Enter advances. Saving happens only after final confirmation.
- On the models page, Ctrl+A selects all models, A selects or removes the highlighted model, Ctrl+E clears the choices, and Ctrl+S moves to review.
- Ctrl+D marks the harness-wide default. It takes effect only after confirmation, for the current session and future sessions that use the global settings.
- List Providers includes saved sign-ins and providers added with this extension. Providers that merely appear in Pi's built-in catalog are hidden.
- Skins change client headers. They do not sign into another app or give access to its subscription.
- Checks use temporary settings and made-up keys.
- An explicitly entered http:// address is kept, which allows local servers. Addresses without a scheme use https://.
- Extra keys stay on this machine in a file restricted to your user account. They are not encrypted by the extension.
- Adding a provider with an existing name asks for a different name rather than replacing the old provider.
- Models chosen in this wizard are the models saved for the new provider. Existing choices for other providers are kept.
- If a server does not offer a model list, you can add model names manually. A missing model list alone does not mean the key is wrong.
- Google uses its actual model-specific generate-content route. The requested /v1/generativecontent choice names that method; it is not a separate endpoint that Pi supports.

- GLM remains the worker model for this project. The user approved terminal workers so they can use shell and file tools. Each worker has a stated assignment; the orchestrator reviews and tests its changes.
- Skin presets use fixed, checked app versions and do not check for new versions when Pi starts. Their headers can be overridden in the form.
- Manual models start with Pi's usual limits: 128000 context tokens and 16384 output tokens. The form lets you edit them and choose thinking/image support.
- Custom header values are hidden while typing. Non-secret header values are visible during review; keys and secret-like values remain hidden.
- For the lowest startup cost, the recommended install includes Pi-Bolt's own compile step. Source loading remains available for development and has the harness's normal loader cost.
- Commits use your GitHub name and private GitHub email address, with no AI authorship footers.
- The repository uses the MIT license, matching Pi-Bolt.

## Provider list, model choices, and thinking update

- Search starts ready for typing. Tab or Down moves to the provider rows, where E edits and D deletes. This lets you type names containing D and E in search.
- The number beside a provider is the number of its chat models currently known to Pi.
- Deleting asks once before removing that provider's saved sign-in, extra keys, model setup, and saved choices. Other providers stay unchanged. A sign-in managed outside Pi's saved files can still exist outside the extension.
- Renaming an added provider changes its displayed name and keeps its saved identity, so existing references keep working.
- Editing a provider signed in through /login changes model choices and thinking details while keeping its sign-in and connection. It does not ask you to copy a sign-in token into the form.
- The models you select become your saved choices and take effect in the current saved conversation. Other providers keep the choices currently active for them. If everything was enabled before, their available models remain enabled.
- Pi's public extension tools cannot change the current choices directly. After saving, the extension reopens the same conversation to load those choices. Its messages and current model are retained when that model still exists. If it was removed, an available model replaces it.
- Explicit launch or project choices still take priority over global choices. A conversation that is never saved cannot be reopened; its saved choices apply to the next saved conversation.
- Thinking support is copied from the provider's advertised details or matching details already known to Pi. A familiar-looking model name alone does not prove what it supports.
- T on the models screen lets you enable thinking or change its levels. Blank levels use Pi's usual levels; higher levels appear only when the provider, Pi's matching model details, or your own choice enables them.
- Custom level values are optional. For example, high=strong means the provider calls that level strong. The extension saves the choice and Pi sends it through its own connection code.
