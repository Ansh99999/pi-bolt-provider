import type { ThinkingLevel, ThinkingLevelMap } from "./types.ts";

const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MAX_VALUE_LENGTH = 64;
const CONTROL_CHARACTERS = /\p{Cc}/u;

function isLevel(value: string): value is ThinkingLevel {
  return LEVELS.includes(value as ThinkingLevel);
}

function isSafeValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_VALUE_LENGTH && !CONTROL_CHARACTERS.test(value);
}

function invalidValueMessage(level: string): string {
  return `thinkingLevelMap.${level} must be null or a nonempty string of at most ${MAX_VALUE_LENGTH} characters without control characters.`;
}

export function validateThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("thinkingLevelMap must be an object.");
  }

  let keys: Array<string | symbol>;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new Error("thinkingLevelMap could not be read.");
  }

  const result: ThinkingLevelMap = {};
  for (const key of keys) {
    if (typeof key !== "string" || !isLevel(key)) {
      throw new Error(`thinkingLevelMap has an unsupported level: ${typeof key === "symbol" ? String(key) : key}.`);
    }
    if (!Object.hasOwn(value, key)) continue;

    let property: unknown;
    try {
      property = value[key as keyof typeof value];
    } catch {
      throw new Error(`thinkingLevelMap.${key} could not be read.`);
    }
    if (property === null) {
      result[key] = null;
      continue;
    }
    if (typeof property !== "string" || !isSafeValue(property)) throw new Error(invalidValueMessage(key));
    result[key] = property;
  }
  if (LEVELS.every((level) => result[level] === null)) throw new Error("At least one thinking level must remain available.");
  return result;
}

function ownValue(row: Record<string, unknown>, key: string): { present: boolean; value?: unknown } {
  try {
    if (!Object.hasOwn(row, key)) return { present: false };
    return { present: true, value: row[key] };
  } catch {
    return { present: false };
  }
}

function safeMap(value: unknown): ThinkingLevelMap | undefined {
  try {
    return validateThinkingLevelMap(value);
  } catch {
    return undefined;
  }
}

function hasNonOffCapability(map: ThinkingLevelMap): boolean {
  return LEVELS.some((level) => level !== "off" && map[level] !== null && map[level] !== undefined);
}

function mapFromEfforts(value: unknown): ThinkingLevelMap | undefined {
  if (!Array.isArray(value)) return undefined;

  const map: ThinkingLevelMap = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };

  try {
    for (const raw of value) {
      if (typeof raw !== "string") return undefined;
      if (isSafeValue(raw) && !isLevel(raw) && raw !== "none") continue;
      if (!isSafeValue(raw)) return undefined;
      const level = raw === "none" ? "off" : isLevel(raw) ? raw : undefined;
      if (!level) continue;
      const existing = map[level];
      if (existing !== null && existing !== undefined) {
        if (existing !== raw) return undefined;
        continue;
      }
      map[level] = raw;
    }
  } catch {
    return undefined;
  }
  return Object.values(map).some((value) => value !== null) ? map : undefined;
}

export function discoveredThinking(row: Record<string, unknown>): {
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
} {
  const explicitReasoning = ownValue(row, "reasoning");
  const reasoning = typeof explicitReasoning.value === "boolean" ? explicitReasoning.value : undefined;

  let thinkingLevelMap: ThinkingLevelMap | undefined;
  for (const key of ["thinkingLevelMap", "thinking_level_map"]) {
    const candidate = ownValue(row, key);
    if (!candidate.present) continue;
    const map = safeMap(candidate.value);
    if (map) {
      thinkingLevelMap = map;
      break;
    }
  }

  if (!thinkingLevelMap) {
    for (const key of ["supported_reasoning_efforts", "reasoning_efforts"]) {
      const candidate = ownValue(row, key);
      if (!candidate.present) continue;
      const map = mapFromEfforts(candidate.value);
      if (map) {
        thinkingLevelMap = map;
        break;
      }
    }
  }

  const result: { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap } = {};
  if (reasoning !== undefined) result.reasoning = reasoning;
  if (thinkingLevelMap) {
    result.thinkingLevelMap = thinkingLevelMap;
    if (reasoning !== false && hasNonOffCapability(thinkingLevelMap)) result.reasoning = true;
  }
  return result;
}
