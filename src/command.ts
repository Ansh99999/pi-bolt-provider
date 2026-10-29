import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadSavedProviders, saveProvider } from "./storage.ts";
import type { ProviderDraft, ProviderSummary } from "./types.ts";
import { runWizard } from "./wizard.ts";

const plain = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

async function listProviders(ctx: ExtensionCommandContext): Promise<void> {
  const providers = new Map<string, ProviderSummary>();
  for (const model of ctx.modelRegistry.getAll()) {
    const item = providers.get(model.provider);
    if (item) item.modelCount++;
    else providers.set(model.provider, {
      id: model.provider, name: ctx.modelRegistry.getProviderDisplayName(model.provider),
      baseUrl: model.baseUrl, api: model.api, modelCount: 1, custom: false,
    });
  }
  for (const item of await loadSavedProviders()) providers.set(item.id, {
    ...item, modelCount: Math.max(item.modelCount, providers.get(item.id)?.modelCount ?? 0),
  });
  const items = [...providers.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!items.length) { ctx.ui.notify("No providers found.", "info"); return; }
  const labels = items.map((item) => `${plain(item.name)} · ${item.modelCount} models (${plain(item.id)})`);
  while (true) {
    const selected = await ctx.ui.select("Providers · Esc to return", labels);
    if (selected === undefined) return;
    const item = items[labels.indexOf(selected)];
    if (item) ctx.ui.notify(`${plain(item.name)}\n${plain(item.baseUrl ?? "Built-in connection")}\n${plain(item.api ?? "Native API")} · ${item.modelCount} models`, "info");
  }
}

async function addProvider(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  let retained: ProviderDraft | undefined;
  while (true) {
    const draft = await runWizard(ctx, retained);
    if (!draft) return;
    retained = draft;
    const reserved = [...new Set([
      ...ctx.modelRegistry.getAll().map((model) => model.provider),
      ...ctx.modelRegistry.getRegisteredProviderIds(),
    ])];
    let saved;
    try { saved = await saveProvider(draft, reserved); }
    catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Could not save the provider. Your entries are kept.", "error");
      continue;
    }
    try {
      const result = await ctx.modelRegistry.refresh({ allowNetwork: false });
      if (result.aborted || result.errors.has(saved.providerId)) throw new Error("Model refresh failed");
      if (saved.defaultModelId) {
        const model = ctx.modelRegistry.find(saved.providerId, saved.defaultModelId);
        if (!model || !(await pi.setModel(model))) {
          ctx.ui.notify("Provider added and default saved. The current session could not switch; choose it with /model.", "warning");
          return;
        }
      }
      ctx.ui.notify(`Provider added: ${saved.providerName}${saved.defaultModelId ? ` · default: ${saved.defaultModelId}` : ""}`, "info");
    } catch {
      ctx.ui.notify("Provider added. Pi could not refresh its model list; reopen /model or restart Pi to load the saved provider.", "warning");
    }
    return;
  }
}

export async function runProviderCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  while (true) {
    const current = ctx.model ? ctx.modelRegistry.getProviderDisplayName(ctx.model.provider) : "None selected";
    const label = `Current provider: ${plain(current)}`;
    const selected = await ctx.ui.select("Provider", [label, "Add provider", "List Providers"]);
    if (selected === undefined) return;
    try {
      if (selected === label) ctx.ui.notify(ctx.model ? `${plain(current)}\nModel: ${plain(ctx.model.id)}` : "Choose a model with /model.", "info");
      else if (selected === "Add provider") await addProvider(pi, ctx);
      else if (selected === "List Providers") await listProviders(ctx);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Could not open providers.", "error");
    }
  }
}
