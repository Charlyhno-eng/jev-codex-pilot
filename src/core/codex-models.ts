import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CodexModel, Complexity, Reasoning } from "./types.js";

export type ModelRoute = { model: CodexModel; reasoning: Reasoning };

export interface CodexSettings {
  models: Record<string, string>;
  modelLevels: readonly CodexModel[];
  reasoningLevels: readonly Reasoning[];
  complexityRoutes: Record<Complexity, readonly ModelRoute[]>;
}

const fallbackModels = { luna: "gpt-6-luna", sol: "gpt-6-sol", astra: "gpt-6-astra" };
const fallbackReasoning = ["low", "medium", "high", "xhigh", "max"];
const fallbackRoutes: Record<Complexity, string[]> = {
  1: ["luna:medium"], 2: ["luna:high"], 3: ["luna:max"],
  4: ["sol:high"], 5: ["sol:xhigh"]
};
const complexityLevels: Complexity[] = [1, 2, 3, 4, 5];

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
  let content = "";
  if (existsSync(file)) {
    content = readFileSync(file, "utf8");
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

  const complexityRoutes = {} as Record<Complexity, ModelRoute[]>;
  for (const level of complexityLevels) {
    const section = content.match(new RegExp(`(?:^|\\n)\\s*\\[complexity\\.${level}\\]([\\s\\S]*?)(?=\\n\\s*\\[|$)`))?.[1];
    const configured = section?.match(/^\s*routes\s*=\s*(\[[^\n]*\])/m)?.[1];
    if (section && !configured) throw new Error(`Complexity ${level} needs a routes array in ${file}`);
    const routeNames = configured ? parseStringArray(configured) : fallbackRoutes[level];
    const routes = routeNames.map(route => {
      const [model, reasoning, extra] = route.split(":");
      if (!model || !reasoning || extra || !models[model] || !reasoningLevels.includes(reasoning)) throw new Error(`Invalid complexity ${level} route in ${file}: ${route}`);
      return { model, reasoning };
    });
    if (!routes.length) throw new Error(`Complexity ${level} must have at least one route in ${file}`);
    complexityRoutes[level] = routes;
  }

  const modelLevels = Object.keys(models);
  return {
    models,
    modelLevels,
    reasoningLevels,
    complexityRoutes,
  };
}

const settings = readCodexSettings();
/** Model keys are stable routing names; their Codex IDs are configurable. */
export const MODEL_LEVELS: readonly CodexModel[] = settings.modelLevels;
export const REASONING_LEVELS: readonly Reasoning[] = settings.reasoningLevels;
export const COMPLEXITY_ROUTES = settings.complexityRoutes;

/** Returns configured Codex routes for one complexity level. */
export function routesForComplexity(complexity: Complexity): readonly ModelRoute[] { return COMPLEXITY_ROUTES[complexity]; }
/** Returns the preferred Codex route for one complexity level. */
export function defaultRoute(complexity: Complexity): ModelRoute { return routesForComplexity(complexity)[0]; }
/** Lists reasoning levels allowed for a model at this complexity. */
export function allowedEfforts(complexity: Complexity, model: CodexModel): Reasoning[] {
  return REASONING_LEVELS.filter(reasoning => routesForComplexity(complexity).some(route => route.model === model && route.reasoning === reasoning));
}
const escalationRoutes: readonly ModelRoute[] = [
  { model: "luna", reasoning: "low" },
  { model: "luna", reasoning: "medium" },
  { model: "luna", reasoning: "high" },
  { model: "luna", reasoning: "max" },
  { model: "sol", reasoning: "high" },
  { model: "sol", reasoning: "xhigh" }
];

/** Returns the next stronger route when a Codex ticket attempt fails. */
export function nextEscalationRoute(model: CodexModel, reasoning: Reasoning): ModelRoute | undefined {
  const index = escalationRoutes.findIndex(route => route.model === model && route.reasoning === reasoning);
  const next = index >= 0 ? escalationRoutes[index + 1] : undefined;
  return next && settings.models[next.model] && settings.reasoningLevels.includes(next.reasoning) ? next : undefined;
}

/** Keeps continuation reasoning within the configured range for its model. */
export function clampModelReasoning(model: CodexModel, requested: Reasoning): Reasoning {
  const allowed = Object.values(COMPLEXITY_ROUTES).flat().filter(route => route.model === model).map(route => route.reasoning);
  if (!allowed.length) return clampReasoning(model, requested);
  return allowed.reduce((best, effort) => Math.abs(reasoningIndex(effort) - reasoningIndex(requested)) < Math.abs(reasoningIndex(best) - reasoningIndex(requested)) ? effort : best);
}

/** Resolves a configured model key to the active Codex model name. */
export function codexModelId(tier: CodexModel): string {
  const override = process.env[`JEV_CODEX_MODEL_${tier.toUpperCase()}`]?.trim();
  return override || settings.models[tier] || settings.models[MODEL_LEVELS[0]] || tier;
}

/** Returns the reasoning level at an index or a fallback. */
export function reasoningAt(index: number, fallback: Reasoning = "low"): Reasoning {
  return REASONING_LEVELS[Math.max(0, Math.min(REASONING_LEVELS.length - 1, index))] ?? fallback;
}

/** Returns the configured index of a reasoning level. */
export function reasoningIndex(value: Reasoning): number {
  const index = REASONING_LEVELS.indexOf(value);
  if (index >= 0) return index;
  if (value === "max") return Math.max(0, REASONING_LEVELS.length - 1);
  if (value === "xhigh") return Math.max(0, REASONING_LEVELS.length - 2);
  return 0;
}

function reasoningBounds(tier: CodexModel): { minimum: number; maximum: number } {
  const allowed = Object.values(COMPLEXITY_ROUTES).flat().filter(route => route.model === tier).map(route => reasoningIndex(route.reasoning));
  return { minimum: Math.min(...allowed), maximum: Math.max(...allowed) };
}

function clampReasoning(tier: CodexModel, reasoning: Reasoning): Reasoning {
  const bounds = reasoningBounds(tier);
  return reasoningAt(Math.max(bounds.minimum, Math.min(bounds.maximum, reasoningIndex(reasoning))));
}
