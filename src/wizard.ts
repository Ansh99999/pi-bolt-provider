import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { displayProviderName, normalizeEndpoint } from "./endpoints.ts";
import { SKINS, validateHeader } from "./headers.ts";
import { checkKey, fetchModels } from "./network.ts";
import { emptyDraft } from "./types.ts";
import { validateThinkingLevelMap } from "./thinking.ts";
import type { Method, ProviderDraft, ProviderModel, ThinkingLevel, ThinkingLevelMap } from "./types.ts";

const STEPS = ["Name", "Base URL", "Method", "API keys", "Header / Skin", "Models", "Review"];
const METHODS: { id: Method; label: string }[] = [
  { id: "responses", label: "/v1/responses" },
  { id: "messages", label: "/v1/messages" },
  { id: "chat", label: "/v1/chat/completions" },
  { id: "generative", label: "/v1/generativecontent · Google" },
];
type FormKind = "key" | "header" | "model" | "thinking";
type Field = { label: string; value: string; secret?: boolean };
type Form = { kind: FormKind; fields: Field[]; index: number; modelId?: string };
type Services = { fetchModels: typeof fetchModels; checkKey: typeof checkKey };
type ThemeLike = Pick<Theme, "fg">;
export interface WizardOptions {
  theme: ThemeLike;
  refresh: () => void;
  rows: () => number;
  done: (draft: ProviderDraft | undefined) => void;
  initialDraft?: ProviderDraft;
  startAt?: "name" | "models" | "review";
  knownModels?: readonly (ProviderModel & { api?: string })[];
  services?: Services;
}
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
const sensitive = (name: string) => /key|token|secret|cookie|auth/i.test(name);
const yes = (value: string) => /^(?:y|yes|true|1)$/i.test(value.trim());
const yesNo = (value: string) => /^(?:y|yes|true|1|n|no|false|0)$/i.test(value.trim());
const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function levelText(model: ProviderModel): string {
  if (!model.thinkingLevelMap) return "";
  return LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null &&
    ((level !== "xhigh" && level !== "max") || model.thinkingLevelMap?.[level] !== undefined))
    .map((level) => {
      const value = model.thinkingLevelMap?.[level];
      return value && value !== level ? `${level}=${value}` : level;
    }).join(",");
}

function parseLevels(text: string): ThinkingLevelMap | undefined {
  if (!text.trim()) return undefined;
  const result: ThinkingLevelMap = Object.fromEntries(LEVELS.map((level) => [level, null]));
  for (const entry of text.split(",")) {
    const [rawLevel, ...values] = entry.trim().split("=");
    const level = rawLevel.trim() as ThinkingLevel;
    if (!LEVELS.includes(level)) throw new Error("Use off, minimal, low, medium, high, xhigh or max, separated by commas.");
    // An unqualified off uses Pi's native handling for the chosen protocol.
    if (level === "off" && !values.length) delete result.off;
    else result[level] = values.length ? values.join("=").trim() : level;
  }
  return validateThinkingLevelMap(result);
}

// Input provides editing, paste, scrolling and cursor placement. Only its display is masked.
function masked(line: string): string {
  return line.split(/(\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_][^\x07]*(?:\x07|\x1b\\)))/g)
    .map((part) => part.startsWith("\x1b") ? part : part.replace(/[^ ]/gu, "•")).join("");
}

export class ProviderWizard {
  private readonly theme: ThemeLike;
  private readonly refresh: () => void;
  private readonly rows: () => number;
  private readonly finish: WizardOptions["done"];
  private readonly services: Services;
  private readonly draft: ProviderDraft;
  private readonly knownModels: WizardOptions["knownModels"];
  private readonly input = new Input();
  private readonly manualModels = new Set<string>();
  private readonly pendingForms = new Map<FormKind, Field[]>();
  private pendingThinkingModel?: string;
  private step = 0;
  private row = 0;
  private form?: Form;
  private error = "";
  private status = "";
  private statusTone: "success" | "muted" | "warning" = "muted";
  private busy = "";
  private controller?: AbortController;
  private operation = 0;
  private disposed = false;
  private hasFocus = false;

  constructor(options: WizardOptions) {
    this.theme = options.theme; this.refresh = options.refresh; this.rows = options.rows;
    this.finish = options.done; this.services = options.services ?? { fetchModels, checkKey };
    this.draft = structuredClone(options.initialDraft ?? emptyDraft());
    this.knownModels = options.knownModels;
    if (options.initialDraft) {
      this.step = options.startAt === "name" ? 0 : options.startAt === "models" ? 5 : 6;
      for (const model of this.draft.models) this.manualModels.add(model.id);
    }
    this.input.onSubmit = (value) => this.submitInput(value);
    this.configureInput();
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.input.focused = value && this.inputActive(); }
  invalidate(): void { this.input.invalidate(); }
  dispose(): void { this.disposed = true; this.cancelWork(); }
  private changed(): void { if (!this.disposed) this.refresh(); }
  private inputActive(): boolean { return !!this.form || this.step < 2; }
  private secretInput(): boolean { return this.form?.kind === "key" || (this.form?.kind === "header" && this.form.index === 1); }

  private configureInput(): void {
    this.input.setValue(clean(this.form ? this.form.fields[this.form.index].value : this.step === 0 ? this.draft.name : this.step === 1 ? this.draft.baseUrl : ""));
    this.input.handleInput("\x05"); // Native end-of-line action, so existing values are easy to replace.
    this.input.focused = this.hasFocus && this.inputActive();
  }

  private syncInput(): void {
    const value = clean(this.input.getValue());
    if (value !== this.input.getValue()) this.input.setValue(value);
    if (this.form) this.form.fields[this.form.index].value = value;
    else if (this.step === 0) this.draft.name = value;
    else if (this.step === 1) this.draft.baseUrl = value;
  }

  private go(step: number): void {
    if (this.inputActive()) this.syncInput();
    this.step = Math.max(0, Math.min(6, step)); this.row = 0; this.form = undefined;
    this.error = ""; this.status = ""; this.statusTone = "muted";
    if (this.step === 2) this.row = Math.max(0, METHODS.findIndex((method) => method.id === this.draft.method));
    if (this.step === 4) this.row = Math.max(0, SKINS.findIndex((skin) => skin.id === this.draft.skin));
    if (this.step === 3 && !this.draft.keys.length) this.startForm("key");
    else this.configureInput();
    this.changed();
  }

  private startForm(kind: FormKind): void {
    const target = kind === "thinking" ? this.draft.models[this.row] : undefined;
    if (kind === "thinking" && !target) return;
    if (kind === "thinking" && this.pendingThinkingModel !== target?.id) this.pendingForms.delete(kind);
    let fields = this.pendingForms.get(kind)?.map((field) => ({ ...field }));
    fields ??= kind === "key" ? [{ label: "API key", value: "", secret: true }]
      : kind === "header" ? [{ label: "Header name", value: "" }, { label: "Header value", value: "", secret: true }]
      : kind === "thinking" ? [
        { label: "Supports thinking? (yes/no)", value: target?.reasoning ? "yes" : "no" },
        { label: "Thinking levels (blank = Pi defaults)", value: target ? levelText(target) : "" },
      ] : [
        { label: "Model ID", value: "" }, { label: "Display name (optional)", value: "" },
        { label: "Context limit", value: "128000" }, { label: "Maximum output tokens", value: "16384" },
        { label: "Supports thinking? (yes/no)", value: "no" }, { label: "Accepts images? (yes/no)", value: "no" },
      ];
    this.form = { kind, fields, index: 0, ...(target ? { modelId: target.id } : {}) }; this.error = ""; this.status = "";
    this.configureInput(); this.changed();
  }

  private fail(message: string): void { this.error = message; this.changed(); }

  private submitInput(raw: string): void {
    if (this.busy) return;
    this.syncInput();
    const value = clean(raw).trim();
    try {
      if (!this.form) {
        if (this.step === 0) { this.draft.name = value; this.input.setValue(value); this.go(1); }
        else {
          normalizeEndpoint(value, this.draft.method);
          this.draft.baseUrl = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`).toString();
          this.input.setValue(this.draft.baseUrl);
          this.go(2);
        }
        return;
      }
      const form = this.form;
      const index = form.index;
      if (form.kind === "key") {
        if (!value || value.length > 16384 || /[^\x21-\x7e]/.test(value)) throw new Error("Enter a key without spaces or line breaks.");
        if (this.draft.keys.includes(value)) throw new Error("That key is already listed.");
      } else if (form.kind === "header") {
        if (index === 0) validateHeader(value, "");
        else validateHeader(form.fields[0].value, clean(raw));
      } else if (form.kind === "thinking") {
        if (index === 0 && !yesNo(value)) throw new Error("Enter yes or no.");
        if (index === 1 && yes(form.fields[0].value)) parseLevels(value);
      } else {
        if (index === 0 && (!value || /[\s\u007f-\u009f]/.test(value))) throw new Error("Enter a model ID without spaces.");
        if (index === 2 || index === 3) {
          const number = Number(value);
          if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Enter a positive whole number.");
          if (index === 3 && number > Number(form.fields[2].value)) throw new Error("Output cannot exceed the context limit.");
        }
        if (index >= 4 && !yesNo(value)) throw new Error("Enter yes or no.");
      }
      form.fields[index].value = form.kind === "header" && index === 1 ? clean(raw) : value;
      this.error = "";
      if (index < form.fields.length - 1) {
        if (form.kind === "model" && index === 0) {
          const known = this.withKnownThinking({ id: value });
          if (known.reasoning !== undefined) form.fields[4].value = known.reasoning ? "yes" : "no";
        }
        form.index++; this.configureInput(); this.changed(); return;
      }
      const values = form.fields.map((field) => field.value);
      if (form.kind === "key") {
        this.draft.keys.push(values[0]); this.draft.selectedKey = this.draft.keys.length - 1;
      } else if (form.kind === "header") {
        const lower = values[0].toLowerCase();
        for (const name of Object.keys(this.draft.headers)) if (name.toLowerCase() === lower) delete this.draft.headers[name];
        this.draft.headers[values[0]] = values[1];
        this.row = SKINS.length + Object.keys(this.draft.headers).length - 1;
      } else if (form.kind === "thinking") {
        const model = this.draft.models.find((model) => model.id === form.modelId);
        if (model) {
          model.reasoning = yes(values[0]);
          const map = model.reasoning ? parseLevels(values[1]) : undefined;
          if (map) model.thinkingLevelMap = map; else delete model.thinkingLevelMap;
          this.manualModels.add(model.id);
        }
      } else {
        const model: ProviderModel = { id: values[0], ...(values[1] ? { name: values[1] } : {}),
          contextWindow: Number(values[2]), maxTokens: Number(values[3]), reasoning: yes(values[4]),
          input: yes(values[5]) ? ["text", "image"] : ["text"] };
        const known = this.withKnownThinking({ id: model.id });
        if (model.reasoning && known.thinkingLevelMap) model.thinkingLevelMap = known.thinkingLevelMap;
        const existing = this.draft.models.findIndex((item) => item.id === model.id);
        if (existing < 0) this.draft.models.push(model); else this.draft.models[existing] = model;
        this.manualModels.add(model.id);
        if (!this.draft.selectedModelIds.includes(model.id)) this.draft.selectedModelIds.push(model.id);
        this.row = this.draft.models.findIndex((item) => item.id === model.id);
      }
      this.pendingForms.delete(form.kind); this.form = undefined; this.configureInput(); this.changed();
    } catch (error) { this.fail(error instanceof Error ? error.message : "Check this value."); }
  }

  private cancelWork(): void {
    this.operation++; this.controller?.abort(); this.controller = undefined; this.busy = "";
  }

  private work<T>(label: string, task: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void): void {
    this.cancelWork(); this.error = ""; this.status = ""; this.busy = label;
    const controller = new AbortController(); this.controller = controller;
    const token = this.operation;
    void task(controller.signal).then((value) => {
      if (this.disposed || token !== this.operation) return;
      this.busy = ""; this.controller = undefined; accept(value); this.changed();
    }).catch((error: unknown) => {
      if (this.disposed || token !== this.operation) return;
      this.busy = ""; this.controller = undefined;
      this.fail(error instanceof Error ? error.message : "The request could not be completed.");
    });
    this.changed();
  }

  private checkCurrentKey(): void {
    const copy = structuredClone(this.draft);
    if (this.form?.kind === "key") {
      const value = this.input.getValue().trim();
      if (!value) { this.fail("Enter a key first."); return; }
      copy.keys.push(value); copy.selectedKey = copy.keys.length - 1;
    }
    if (!copy.keys.length) { this.fail("Add a key first."); return; }
    this.work("Checking key… Esc goes back", (signal) => this.services.checkKey(copy, signal), (result) => {
      this.status = result.message;
      this.statusTone = result.status === "valid" ? "success" : "warning";
      if (result.status === "invalid") this.error = result.message;
    });
  }

  private discover(): void {
    this.work("Fetching models… Esc goes back", (signal) => this.services.fetchModels(structuredClone(this.draft), signal), (fetched) => {
      const models = new Map(fetched.map((model) => [model.id, this.withKnownThinking(model)]));
      for (const model of this.draft.models) if (this.manualModels.has(model.id) || this.draft.selectedModelIds.includes(model.id)) models.set(model.id, model);
      this.draft.models = [...models.values()]; this.row = Math.min(this.row, Math.max(0, this.draft.models.length - 1));
      this.status = fetched.length ? `${fetched.length} models fetched. Choose the models to save.` : "No models returned. Press N to add one manually.";
    });
  }

  private withKnownThinking(model: ProviderModel): ProviderModel {
    if (model.reasoning === false || model.thinkingLevelMap !== undefined) return model;
    const api = normalizeEndpoint(this.draft.baseUrl, this.draft.method).api;
    const matches = this.knownModels?.filter((known) => known.id === model.id && (!known.api || known.api === api)) ?? [];
    const first = matches[0];
    if (!first || (model.reasoning === true && !first.reasoning) || matches.some((known) => known.reasoning !== first.reasoning || JSON.stringify(known.thinkingLevelMap) !== JSON.stringify(first.thinkingLevelMap))) return model;
    return { ...model, reasoning: first.reasoning,
      ...(first.thinkingLevelMap ? { thinkingLevelMap: structuredClone(first.thinkingLevelMap) } : {}) };
  }

  private back(): void {
    this.cancelWork(); this.error = ""; this.status = "";
    if (this.form) {
      this.syncInput();
      if (this.form.index > 0) { this.form.index--; this.configureInput(); }
      else {
        const kind = this.form.kind;
        if (kind === "thinking") this.pendingThinkingModel = this.form.modelId;
        this.pendingForms.set(kind, this.form.fields.map((field) => ({ ...field })));
        this.form = undefined;
        if (kind === "key" && !this.draft.keys.length) this.go(2);
        else this.configureInput();
      }
      this.changed(); return;
    }
    if (this.step === 0) { this.finish(undefined); return; }
    if (this.step === 5 && this.draft.preserveConnection) { this.finish(undefined); return; }
    this.go(this.step - 1);
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, Key.escape)) { this.back(); return; }
    if (this.busy) return;
    if (this.step === 3 && matchesKey(data, Key.ctrl("k"))) { this.checkCurrentKey(); return; }
    if (this.inputActive()) {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue().length > 64000) { this.input.setValue(previous); this.error = "That value is too long."; }
      this.syncInput(); this.changed(); return;
    }
    this.error = "";
    const up = matchesKey(data, Key.up);
    const down = matchesKey(data, Key.down);
    if (this.step === 2) {
      if (up || down) this.row = (this.row + (up ? -1 : 1) + METHODS.length) % METHODS.length;
      if (matchesKey(data, Key.enter)) { this.draft.method = METHODS[this.row].id; this.go(3); return; }
    } else if (this.step === 3) {
      if (up || down) this.draft.selectedKey = (this.draft.selectedKey + (up ? -1 : 1) + this.draft.keys.length) % this.draft.keys.length;
      else if (data.toLowerCase() === "n") { this.startForm("key"); return; }
      else if (data.toLowerCase() === "d") {
        this.draft.keys.splice(this.draft.selectedKey, 1);
        this.draft.selectedKey = Math.max(0, Math.min(this.draft.selectedKey, this.draft.keys.length - 1));
        if (!this.draft.keys.length) this.startForm("key");
      } else if (matchesKey(data, Key.enter)) { this.go(4); return; }
    } else if (this.step === 4) {
      const names = Object.keys(this.draft.headers);
      const count = SKINS.length + names.length;
      if (up || down) this.row = (this.row + (up ? -1 : 1) + count) % count;
      else if (data.toLowerCase() === "n") { this.startForm("header"); return; }
      else if (data.toLowerCase() === "d" && this.row >= SKINS.length) { delete this.draft.headers[names[this.row - SKINS.length]]; this.row = Math.max(0, this.row - 1); }
      else if (data === " " && this.row < SKINS.length) this.draft.skin = SKINS[this.row].id;
      else if (matchesKey(data, Key.enter)) {
        if (this.row < SKINS.length) this.draft.skin = SKINS[this.row].id;
        this.go(5); return;
      }
    } else if (this.step === 5) {
      const count = this.draft.models.length;
      if (up || down) this.row = Math.max(0, Math.min(count - 1, this.row + (up ? -1 : 1)));
      else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) this.row = Math.max(0, Math.min(count - 1, this.row + (matchesKey(data, Key.pageUp) ? -10 : 10)));
      else if (data === " " && !this.draft.preserveConnection) { this.discover(); return; }
      else if (matchesKey(data, Key.ctrl("a"))) this.draft.selectedModelIds = this.draft.models.map((model) => model.id);
      else if (matchesKey(data, Key.ctrl("e"))) { this.draft.selectedModelIds = []; delete this.draft.defaultModelId; }
      else if (data.toLowerCase() === "n" && !this.draft.preserveConnection) { this.startForm("model"); return; }
      else if (data.toLowerCase() === "t" && count) { this.startForm("thinking"); return; }
      else if (data.toLowerCase() === "a" && count) {
        const id = this.draft.models[this.row].id;
        if (this.draft.selectedModelIds.includes(id)) {
          this.draft.selectedModelIds = this.draft.selectedModelIds.filter((value) => value !== id);
          if (this.draft.defaultModelId === id) delete this.draft.defaultModelId;
        } else this.draft.selectedModelIds.push(id);
      } else if (matchesKey(data, Key.ctrl("d")) && count) {
        const id = this.draft.models[this.row].id;
        this.draft.defaultModelId = id;
        if (!this.draft.selectedModelIds.includes(id)) this.draft.selectedModelIds.push(id);
      } else if (matchesKey(data, Key.ctrl("s")) || matchesKey(data, Key.enter)) {
        if (!this.draft.selectedModelIds.length) { this.fail("Choose at least one model. A selects one; Ctrl+A selects all."); return; }
        this.go(6); return;
      }
    } else if (this.step === 6) {
      if (up || down) this.row = Math.max(0, this.row + (up ? -1 : 1));
      else if (matchesKey(data, Key.enter)) {
        if ((!this.draft.preserveConnection && !this.draft.keys.length) || !this.draft.selectedModelIds.length) { this.fail("Go back and add a key and at least one model."); return; }
        try { normalizeEndpoint(this.draft.baseUrl, this.draft.method); }
        catch (error) { this.fail(error instanceof Error ? error.message : "Check the address."); return; }
        this.finish(structuredClone(this.draft)); return;
      }
    }
    this.changed();
  }

  private headerValue(name: string, value: string): string {
    return sensitive(name) || this.draft.keys.some((key) => key && value.includes(key)) ? "[hidden]" : clean(value);
  }

  private window(items: string[], selected: number, limit: number): string[] {
    if (!items.length) return [this.theme.fg("muted", "Nothing here yet.")];
    const start = Math.max(0, Math.min(selected - Math.floor(limit / 2), items.length - limit));
    const lines: string[] = [];
    for (let index = start; index < Math.min(items.length, start + limit); index++) {
      const line = `${index === selected ? "› " : "  "}${items[index]}`;
      lines.push(index === selected ? this.theme.fg("accent", line) : line);
    }
    if (items.length > limit && lines.length) lines[lines.length - 1] += this.theme.fg("dim", `  (${selected + 1}/${items.length})`);
    return lines;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const height = Math.max(1, this.rows());
    const slots = Math.max(1, height - 10);
    const body: string[] = [];
    let hint = "Enter → next · Esc → back";
    if (this.inputActive()) {
      const label = this.form ? this.form.fields[this.form.index].label : this.step === 0 ? "Provider name (optional)" : "Base URL";
      body.push(label);
      const inputLines = this.input.render(Math.max(1, width - 2));
      body.push(...inputLines.map((line) => `  ${this.secretInput() ? masked(line) : line}`));
      if (!this.form && this.step === 0) body.push(this.theme.fg("muted", "Leave blank to use the address's host name."));
      if (!this.form && this.step === 1) body.push(this.theme.fg("muted", "example.com is enough. Pasted /v1 paths work too."));
      if (this.form?.kind === "key") hint += " · Ctrl+K check";
      if (this.form?.kind === "model") body.push(this.theme.fg("muted", `Model details · ${this.form.index + 1}/${this.form.fields.length}`));
      if (this.form?.kind === "thinking" && this.form.index === 1) body.push(this.theme.fg("muted", "Example: off,low,medium,high. Use high=value for a provider's own value."));
    } else if (this.step === 2) {
      body.push(...this.window(METHODS.map((method) => method.label), this.row, slots));
      hint = "↑↓ choose · Enter → next · Esc → back";
    } else if (this.step === 3) {
      body.push(...this.window(this.draft.keys.map((_key, index) => `Key ${index + 1}  ••••••••${index === this.draft.selectedKey ? "  active" : ""}`), this.draft.selectedKey, slots));
      hint = "↑↓ active key · N add · D delete · Ctrl+K check · Enter next · Esc back";
    } else if (this.step === 4) {
      const items = SKINS.map((skin) => `${skin.id === this.draft.skin ? "[x]" : "[ ]"} ${skin.label}`);
      items.push(...Object.entries(this.draft.headers).map(([name, value]) => `${clean(name)}: ${this.headerValue(name, value)}`));
      body.push(...this.window(items, this.row, slots));
      hint = "↑↓ choose · Space set skin · N header · D delete · Enter next · Esc back";
    } else if (this.step === 5) {
      if (!this.draft.models.length) body.push("Press SPACE to fetch models", this.theme.fg("muted", "Or press N to add a model manually."));
      else {
        const selected = new Set(this.draft.selectedModelIds);
        const start = Math.max(0, Math.min(this.row - Math.floor(slots / 2), this.draft.models.length - slots));
        for (let index = start; index < Math.min(this.draft.models.length, start + slots); index++) {
          const model = this.draft.models[index];
          const line = `${index === this.row ? "›" : " "} ${selected.has(model.id) ? "[x]" : "[ ]"} ${clean(model.id)}${model.reasoning ? "  thinking" : ""}${model.id === this.draft.defaultModelId ? "  ★ default" : ""}`;
          body.push(index === this.row ? this.theme.fg("accent", line) : line);
        }
      }
      body.push(this.theme.fg("muted", `${this.draft.selectedModelIds.length} selected / ${this.draft.models.length} listed`));
      hint = `${this.draft.preserveConnection ? "" : "SPACE fetch · N new · "}A select · T thinking · Ctrl+A all · Ctrl+E clear`;
    } else {
      let endpoint: string;
      try { endpoint = normalizeEndpoint(this.draft.baseUrl, this.draft.method).baseUrl; } catch { endpoint = "Check the address"; }
      let name: string;
      try { name = displayProviderName(this.draft.name, this.draft.baseUrl); } catch { name = this.draft.name; }
      const review = [
        `Name: ${clean(name)}`, `Base URL: ${clean(endpoint)}`,
        `Method: ${METHODS.find((method) => method.id === this.draft.method)?.label ?? "Unknown"}`,
        this.draft.preserveConnection ? "Sign-in: keep existing connection" : `Keys: ${this.draft.keys.length} · active Key ${this.draft.selectedKey + 1} ••••••••`,
        `Skin: ${SKINS.find((skin) => skin.id === this.draft.skin)?.label ?? "Pi-Bolt"}`,
        ...Object.entries(this.draft.headers).map(([key, value]) => `Header: ${clean(key)}: ${this.headerValue(key, value)}`),
        `Models: ${this.draft.selectedModelIds.length}`,
        ...this.draft.selectedModelIds.map((id) => {
          const model = this.draft.models.find((model) => model.id === id);
          return `  ${clean(id)}${model?.reasoning ? ` · thinking: ${levelText(model) || "Pi defaults"}` : ""}${id === this.draft.defaultModelId ? " ★ default" : ""}`;
        }),
        `Harness default: ${this.draft.defaultModelId ? clean(this.draft.defaultModelId) : "Keep current default"}`,
      ];
      this.row = Math.min(this.row, Math.max(0, review.length - slots));
      body.push(...review.slice(this.row, this.row + slots));
      hint = "Enter → confirm and save provider · Esc → edit models · ↑↓ review";
    }
    const output = [this.theme.fg("accent", this.draft.editingId ? "Edit provider" : "Add provider"),
      this.theme.fg("muted", `${this.step + 1}/${STEPS.length} · ${STEPS[this.step]}`), "", ...body, ""];
    if (this.busy) output.push(this.theme.fg("muted", this.busy));
    else if (this.error) output.push(this.theme.fg("error", clean(this.error)));
    else if (this.status) output.push(this.theme.fg(this.statusTone, clean(this.status)));
    output.push(this.theme.fg("dim", hint));
    if (this.step === 5 && !this.form) output.push(this.theme.fg("dim", "Ctrl+D default · Ctrl+S save selection → review · PgUp/PgDn · Esc back"));
    return output.slice(0, height).map((line) => truncateToWidth(line, width));
  }
}

export async function runWizard(ctx: ExtensionCommandContext, initialDraft?: ProviderDraft, startAt?: WizardOptions["startAt"]): Promise<ProviderDraft | undefined> {
  return ctx.ui.custom<ProviderDraft | undefined>((tui, theme, _keys, done) => new ProviderWizard({
    theme, refresh: () => tui.requestRender(), rows: () => tui.terminal.rows, done, initialDraft, startAt,
    knownModels: ctx.modelRegistry.getAll(),
  }));
}
