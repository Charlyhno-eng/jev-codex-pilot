import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CodexModel, Reasoning } from "./types.js";

export interface CodexSettings {
  models: Record<string, string>;
  modelLevels: readonly CodexModel[];
  reasoningLevels: readonly Reasoning[];
}

const fallbackModels = { luna: "gpt-6-luna", sol: "gpt-6-sol" };
const fallbackReasoning = ["low", "medium", "high"];

function parseString(value: string): string | undefined {
  try { const parsed: unknown = JSON.parse(value); return typeof parsed === "string" && parsed.trim() ? parsed.trim() : undefined; }
  catch { return undefined; }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && !!item.trim()).map(item => item.trim()) : [];
  } catch { return []; }
}

/** Reads the model and reasoning choices shared by analysis, routing, and the UI. */
export function readCodexSettings(file = resolve(process.cwd(), "config/model.toml")): CodexSettings {
  let models: Record<string, string> = fallbackModels;
  let reasoningLevels: string[] = fallbackReasoning;
  if (existsSync(file)) {
    const content = readFileSync(file, "utf8");
    const modelSection = content.match(/(?:^|\n)\s*\[models\]([\s\S]*?)(?=\n\s*\[|$)/)?.[1];
    const configuredModels: Record<string, string> = {};
    for (const line of modelSection?.split(/\r?\n/) ?? []) {
      const match = line.match(/^\s*([\w-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
      if (!match) continue;
      const id = parseString(match[2]);
      if (id) configuredModels[match[1]] = id;
    }
    if (Object.keys(configuredModels).length) models = configuredModels;

    const reasoningSection = content.match(/(?:^|\n)\s*\[reasoning\]([\s\S]*?)(?=\n\s*\[|$)/)?.[1];
    const levelsValue = reasoningSection?.match(/^\s*levels\s*=\s*(.*?)\s*(?:#.*)?$/m)?.[1];
    const configuredReasoning = levelsValue ? parseStringArray(levelsValue) : [];
    if (configuredReasoning.length) reasoningLevels = configuredReasoning;
  }

  const modelLevels = Object.keys(models);
  return {
    models,
    modelLevels,
    reasoningLevels,
  };
}

const settings = readCodexSettings();
/** Model keys are stable routing names; their Codex IDs are configurable. */
export const MODEL_LEVELS: readonly CodexModel[] = settings.modelLevels;
export const REASONING_LEVELS: readonly Reasoning[] = settings.reasoningLevels;

/** Resolves a configured model key to the active Codex model name. */
export function codexModelId(tier: CodexModel): string {
  const override = process.env[`JEV_CODEX_MODEL_${tier.toUpperCase()}`]?.trim();
  return override || settings.models[tier] || settings.models[MODEL_LEVELS[0]] || tier;
}

export function reasoningAt(index: number, fallback: Reasoning = "low"): Reasoning {
  return REASONING_LEVELS[Math.max(0, Math.min(REASONING_LEVELS.length - 1, index))] ?? fallback;
}

export function reasoningIndex(value: Reasoning): number {
  const index = REASONING_LEVELS.indexOf(value);
  if (index >= 0) return index;
  return value === "xhigh" ? Math.max(0, REASONING_LEVELS.length - 1) : 0;
}
