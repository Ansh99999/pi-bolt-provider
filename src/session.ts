import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SaveResult } from "./types.ts";

/** Snapshot the choices before changing the catalog, including unrelated providers. */
export function scopeForSave(pi: ExtensionAPI, ctx: ExtensionCommandContext): string[] {
  const scoped = ctx.scopedModels;
  const references = scoped.length
    ? scoped.map(({ model, thinkingLevel }) => `${model.provider}/${model.id}${thinkingLevel ? `:${thinkingLevel}` : ""}`)
    : ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
  // Keep saved choices for disconnected providers too. Broad patterns are expanded above,
  // so they cannot silently re-enable a model deselected in this workflow.
  const configured = pi.getSettings().enabledModels ?? [];
  const availableProviders = new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider));
  for (const pattern of configured) {
    const provider = pattern.split("/", 1)[0];
    if (pattern.includes("/") && !/[?*]/.test(provider) && !availableProviders.has(provider)) references.push(pattern);
  }
  return [...new Set(references)];
}

/** Use the supported session-resume API to apply saved settings and current model metadata. */
export async function applySavedChanges(
  pi: ExtensionAPI, ctx: ExtensionCommandContext, saved?: SaveResult, removedId?: string,
): Promise<boolean> {
  const notify = ctx.ui.notify.bind(ctx.ui);
  const message = saved ? `Provider ${saved.providerName} saved. Model choices and thinking settings applied.` : "Provider deleted.";
  try {
    const result = await ctx.modelRegistry.refresh({ allowNetwork: false });
    if (result.aborted || (saved && result.errors.has(saved.providerId))) throw new Error("Catalog refresh failed");
    const current = ctx.model;
    const available = ctx.modelRegistry.getAvailable();
    const preferred = saved?.defaultModelId
      ? ctx.modelRegistry.find(saved.providerId, saved.defaultModelId)
      : current && current.provider !== removedId ? ctx.modelRegistry.find(current.provider, current.id) : undefined;
    const target = preferred ?? (saved ? available.find((model) => model.provider === saved.providerId) : undefined) ?? available[0];
    // Re-selecting also updates the model object used by /thinking and persists the current
    // branch before resuming. This does not change global defaults unless explicitly saved.
    if (target && !(await pi.setModel(target))) throw new Error("Could not apply model");
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      notify("Provider changes saved. This temporary conversation cannot reload model choices; they apply in your next saved conversation.", "warning");
      return true;
    }
    let announce: (() => void) | undefined;
    const switched = await ctx.switchSession(sessionFile, { withSession: async (fresh) => {
      const selected = saved?.enabledModels?.filter((ref) => ref.startsWith(`${saved.providerId}/`)) ?? [];
      const applied = new Set(fresh.scopedModels.map(({ model }) => `${model.provider}/${model.id}`));
      const active = fresh.scopedModels.length ? applied : new Set(fresh.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`));
      const expected = new Set(selected);
      const overridden = selected.some((ref) => !active.has(ref)) ||
        (saved && [...active].some((ref) => ref.startsWith(`${saved.providerId}/`) && !expected.has(ref)));
      announce = () => fresh.ui.notify(overridden
        ? "Provider saved. This conversation's launch or project settings override the saved model choices."
        : message, overridden ? "warning" : "info");
    } });
    if (switched.cancelled) notify("Provider changes saved. Another extension stopped the conversation refresh; saved choices apply when you resume it.", "warning");
    else announce?.();
  } catch {
    notify("Provider changes saved. Pi could not refresh this conversation; resume it to load the saved choices.", "warning");
  }
  return true;
}
