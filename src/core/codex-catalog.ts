import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { codexModelId, MODEL_LEVELS } from "./codex-models.js";
import type { CodexModel } from "./types.js";

type ModelEntry = { model?: string; id?: string; displayName?: string; upgrade?: string; supportedReasoningEfforts?: Array<{ reasoningEffort: string }> };
let cached: Promise<ModelEntry[]> | undefined;
let expiresAt = 0;

/** Reads the installed Codex model catalog with a short fallback timeout. */
export function availableCodexModels(): Promise<ModelEntry[]> {
  if (cached && Date.now() < expiresAt) return cached;
  expiresAt = Date.now() + 60_000;
  cached = new Promise(resolve => {
    const child = spawn("codex", ["app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const timer = setTimeout(() => finish([]), 2_000);
    const finish = (models: ModelEntry[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      resolve(models);
    };
    child.on("error", () => finish([]));
    child.on("close", () => finish([]));
    child.stdin.on("error", () => finish([]));
    lines.on("line", line => {
      let message: { id?: number; result?: { data?: ModelEntry[] }; error?: unknown };
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 0 && message.result) child.stdin.write(`${JSON.stringify({ method: "model/list", id: 1, params: { limit: 200, includeHidden: true } })}\n`);
      if (message.id === 0 && message.error) finish([]);
      if (message.id === 1) finish(Array.isArray(message.result?.data) ? message.result.data : []);
    });
    child.stdin.write(`${JSON.stringify({ method: "initialize", id: 0, params: { clientInfo: { name: "jev_codex_pilot", title: "JEV Codex Pilot", version: "0.2.0" } } })}\n`);
  });
  return cached;
}

/** Chooses an installed Codex ID while preserving JEV's stable model tiers. */
export function selectCodexModelId(tier: CodexModel, models: ModelEntry[]): string {
  const configured = codexModelId(tier);
  if (process.env[`JEV_CODEX_MODEL_${tier.toUpperCase()}`]?.trim()) return configured;
  if (!MODEL_LEVELS.includes(tier)) return configured;
  if (!models.length) return configured;
  const exact = models.find(entry => (entry.model ?? entry.id) === configured);
  if (exact) return exact.model ?? exact.id!;
  const entries = models.filter(entry => (entry.model ?? entry.id) && (entry.displayName?.toLowerCase().includes(tier.toLowerCase()) || (entry.model ?? entry.id)!.toLowerCase().endsWith(`-${tier.toLowerCase()}`)));
  entries.sort((a, b) => (b.model ?? b.id ?? "").localeCompare(a.model ?? a.id ?? "", undefined, { numeric: true }));
  return entries[0]?.model ?? entries[0]?.id ?? configured;
}

/** Resolves the active model name for execution and display. */
export async function activeCodexModelId(tier: CodexModel): Promise<string> {
  return selectCodexModelId(tier, await availableCodexModels());
}
