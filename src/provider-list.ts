import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ProviderSummary } from "./types.ts";

export type ProviderAction =
  | { action: "edit"; providerId: string }
  | { action: "delete"; providerId: string };

type ThemeLike = Pick<Theme, "fg">;

export interface ProviderListOptions {
  theme: ThemeLike;
  refresh: () => void;
  rows: () => number;
  done: (result: ProviderAction | undefined) => void;
  providers: ProviderSummary[];
}

const API_PATHS: Record<string, string> = {
  "openai-responses": "/v1/responses",
  "openai-codex-responses": "/v1/responses",
  "anthropic-messages": "/v1/messages",
  "openai-completions": "/v1/chat/completions",
  "google-generative-ai": "/v1/generativecontent",
};

// Input handles the terminal editing protocol. This only removes characters that are unsafe to render.
const clean = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

function apiLabel(api: string | undefined): string {
  const key = clean(api ?? "");
  return API_PATHS[key] ?? (key || "Native");
}

export class ProviderList {
  private readonly theme: ThemeLike;
  private readonly refresh: () => void;
  private readonly rows: () => number;
  private readonly finish: ProviderListOptions["done"];
  private readonly providers: ProviderSummary[];
  private readonly input = new Input();
  private query = "";
  private focusRows = false;
  private row = 0;
  private disposed = false;
  private hasFocus = false;

  constructor(options: ProviderListOptions) {
    this.theme = options.theme;
    this.refresh = options.refresh;
    this.rows = options.rows;
    this.finish = options.done;
    this.providers = options.providers;
    this.input.focused = false;
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.focused = value && this.searchFocused;
  }

  get searchFocused(): boolean {
    return !this.focusRows;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.input.focused = false;
  }

  private changed(): void {
    if (!this.disposed) this.refresh();
  }

  private syncQuery(): void {
    const value = clean(this.input.getValue());
    if (value !== this.input.getValue()) this.input.setValue(value);
    if (value !== this.query) {
      this.query = value;
      this.row = 0;
    }
  }

  private matches(provider: ProviderSummary): boolean {
    const needle = this.query.trim().toLowerCase();
    if (!needle) return true;
    return [provider.name, provider.id, provider.api, apiLabel(provider.api)]
      .some((field) => clean(field ?? "").toLowerCase().includes(needle));
  }

  private visible(): ProviderSummary[] {
    return this.providers.filter((provider) => this.matches(provider));
  }

  private focusSearch(): void {
    this.focusRows = false;
    this.input.focused = this.hasFocus;
    this.changed();
  }

  private focusProviderRows(): void {
    if (!this.visible().length) return;
    this.focusRows = true;
    this.input.focused = false;
    this.changed();
  }

  private complete(result: ProviderAction | undefined): void {
    this.disposed = true;
    this.finish(result);
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, Key.escape)) {
      this.complete(undefined);
      return;
    }

    if (matchesKey(data, Key.tab) || (this.searchFocused && matchesKey(data, Key.down))) {
      if (this.searchFocused) {
        this.focusProviderRows();
      } else this.focusSearch();
      return;
    }

    if (this.searchFocused) {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue().length > 4096) this.input.setValue(previous);
      this.syncQuery();
      this.changed();
      return;
    }

    const visible = this.visible();
    if (!visible.length) return;
    this.row = Math.max(0, Math.min(this.row, visible.length - 1));
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.row = (this.row + (matchesKey(data, Key.up) ? -1 : 1) + visible.length) % visible.length;
    } else if (matchesKey(data, Key.enter) || data.toLowerCase() === "e") {
      this.complete({ action: "edit", providerId: visible[this.row].id });
      return;
    } else if (data.toLowerCase() === "d") {
      this.complete({ action: "delete", providerId: visible[this.row].id });
      return;
    }
    this.changed();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.trunc(width));
    if (safeWidth <= 0) return [];

    const height = Math.max(1, Math.trunc(this.rows()));
    const visible = this.visible();
    this.row = Math.max(0, Math.min(this.row, Math.max(0, visible.length - 1)));

    const body: string[] = [];
    const inputWidth = Math.max(1, safeWidth - 2);
    const inputLines = this.input.render(inputWidth).map((line) => truncateToWidth(`  ${line}`, safeWidth));
    body.push(...inputLines);

    const slots = Math.max(0, height - inputLines.length - 5);
    if (!visible.length) {
      if (slots > 0) body.push(this.theme.fg("muted", "No matching providers."));
    } else {
      const start = slots > 0
        ? Math.max(0, Math.min(this.row - Math.floor(slots / 2), visible.length - slots))
        : 0;
      for (let index = start; index < Math.min(visible.length, start + slots); index++) {
        const provider = visible[index];
        const marker = index === this.row ? "› " : "  ";
        const name = `${marker}${clean(provider.name)}`;
        const label = index === this.row && this.focusRows ? this.theme.fg("accent", name) : name;
        body.push(`${label} ${this.theme.fg("dim", apiLabel(provider.api))} (${provider.modelCount})`);
      }
      if (visible.length > slots && slots > 0) {
        body.push(this.theme.fg("dim", `(${this.row + 1}/${visible.length})`));
      }
    }

    const searchState = this.searchFocused ? "focused" : "ready";
    const hint = this.searchFocused
      ? "Tab/↓ → providers · E edit · D delete · Esc back"
      : "↑↓ navigate · E → Edit provider · D → Delete provider · Tab search · Esc back";
    const output = [
      this.theme.fg("accent", "Providers"),
      this.theme.fg("dim", `Search ${searchState}`),
      ...body,
      "",
      this.theme.fg("dim", hint),
    ].map((line) => truncateToWidth(line, safeWidth));

    return output.slice(0, height);
  }

  get focusedProviderId(): string | undefined {
    return this.visible()[this.row]?.id;
  }

  visibleProviderIds(): string[] {
    return this.visible().map((provider) => provider.id);
  }

}

export async function runProviderList(
  ctx: ExtensionCommandContext,
  providers: ProviderSummary[],
): Promise<ProviderAction | undefined> {
  return ctx.ui.custom<ProviderAction | undefined>((tui, theme, _keys, done) => new ProviderList({
    theme,
    refresh: () => tui.requestRender(),
    rows: () => tui.terminal.rows,
    done,
    providers,
  }));
}
