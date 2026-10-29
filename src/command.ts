import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { deleteProvider, loadProviderDraft, loadSavedProviders, saveProvider } from "./storage.ts";
import { runProviderList } from "./provider-list.ts";
import { applySavedChanges, scopeForSave } from "./session.ts";
import type { ProviderDraft, ProviderSummary } from "./types.ts";
import { runWizard } from "./wizard.ts";

const plain = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

export async function configuredProviders(ctx: ExtensionCommandContext): Promise<ProviderSummary[]> {
  const saved = await loadSavedProviders();
  const catalog = ctx.modelRegistry.getAll();
  return saved.map((provider) => {
    const models = catalog.filter((model) => model.provider === provider.id);
    return { ...provider,
      name: provider.name === provider.id ? ctx.modelRegistry.getProviderDisplayName(provider.id) : provider.name,
      api: provider.api ?? models[0]?.api, baseUrl: provider.baseUrl ?? models[0]?.baseUrl,
      modelCount: models.length || provider.modelCount,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function editProvider(pi: ExtensionAPI, ctx: ExtensionCommandContext, initial?: ProviderDraft): Promise<boolean> {
  let retained = initial;
  let startAt: "name" | "models" | "review" | undefined = initial ? initial.preserveConnection ? "models" : "name" : undefined;
  while (true) {
    const draft = await runWizard(ctx, retained, startAt);
    if (!draft) return false;
    retained = draft;
    startAt = "review";
    const reserved = [...new Set([
      ...ctx.modelRegistry.getAll().map((model) => model.provider),
      ...ctx.modelRegistry.getRegisteredProviderIds(),
    ])];
    let saved;
    try { saved = await saveProvider(draft, reserved, undefined, scopeForSave(pi, ctx)); }
    catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Could not save the provider. Your entries are kept.", "error");
      continue;
    }
    return applySavedChanges(pi, ctx, saved);
  }
}

async function listProviders(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
  while (true) {
    const items = await configuredProviders(ctx);
    const action = await runProviderList(ctx, items);
    if (!action) return false;
    const item = items.find((item) => item.id === action.providerId);
    if (!item) continue;
    if (action.action === "edit") {
      const draft = await loadProviderDraft(item.id, ctx.modelRegistry.getAll().filter((model) => model.provider === item.id));
      const active = ctx.scopedModels.length ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
      const activeIds = new Set(active.filter((model) => model.provider === item.id).map((model) => model.id));
      draft.selectedModelIds = draft.models.filter((model) => activeIds.has(model.id)).map((model) => model.id);
      if (draft.defaultModelId && !draft.selectedModelIds.includes(draft.defaultModelId)) delete draft.defaultModelId;
      if (await editProvider(pi, ctx, draft)) return true;
    } else if (await ctx.ui.confirm(`Delete ${plain(item.name)}?`, "Remove this provider's saved sign-in, extra keys, models and choices?")) {
      await deleteProvider(item.id);
      return applySavedChanges(pi, ctx, undefined, item.id);
    }
  }
}

export async function runProviderCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  while (true) {
    const current = ctx.model ? ctx.modelRegistry.getProviderDisplayName(ctx.model.provider) : "None selected";
    const label = `Current provider: ${plain(current)}`;
    const selected = await ctx.ui.select("Provider", [label, "Add provider", "List Providers"]);
    if (selected === undefined) return;
    // A successful save replaces the session context. Always leave this command afterward.
    if (selected === "Add provider") { await editProvider(pi, ctx); return; }
    if (selected === "List Providers") { await listProviders(pi, ctx); return; }
    if (selected === label) ctx.ui.notify(ctx.model ? `${plain(current)}\nModel: ${plain(ctx.model.id)}` : "Choose a model with /model.", "info");
  }
}
