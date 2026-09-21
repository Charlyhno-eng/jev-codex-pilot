import type { CodexModel, Reasoning } from "./types.js";

/** Stable JEV tiers and their current Codex model identifiers. */
export const MODEL_LEVELS: readonly CodexModel[] = ["luna", "terra", "sol"];
export const REASONING_LEVELS: readonly Reasoning[] = ["low", "medium", "high", "xhigh"];

const defaults: Record<CodexModel, string> = {
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
  sol: "gpt-5.6-sol"
};

/** Resolves a stable tier to the active Codex model name. */
export function codexModelId(tier: CodexModel): string {
  const override = process.env[`JEV_CODEX_MODEL_${tier.toUpperCase()}`]?.trim();
  return override || defaults[tier];
}
