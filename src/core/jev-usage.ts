import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface JevTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  calls: number;
  missingCalls: number;
}

const collector = new AsyncLocalStorage<JevTokenUsage>();
const benchmarkUsageFile = "JEV_BENCHMARK_USAGE_FILE";

function addUsage(active: JevTokenUsage, usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void {
  active.calls += 1;
  if (!usage || typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") { active.missingCalls += 1; return; }
  active.inputTokens += usage.inputTokens;
  active.outputTokens += usage.outputTokens;
  active.totalTokens += usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
}

/** Collects JEV provider token usage during one asynchronous execution. */
export async function collectJevUsage<T>(run: () => Promise<T>): Promise<{ result: T; usage: JevTokenUsage }> {
  const usage: JevTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, missingCalls: 0 };
  const result = await collector.run(usage, run);
  return { result, usage };
}

/** Records one JEV provider response in the active usage collector. */
export function recordJevUsage(usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void {
  const active = collector.getStore();
  if (active) { addUsage(active, usage); return; }
  const file = process.env[benchmarkUsageFile];
  if (!file) return;
  try { appendFileSync(file, `${JSON.stringify(usage ?? {})}\n`, "utf8"); }
  catch { /* Benchmark telemetry never changes a JEV decision. */ }
}

/** Reads token-only records written by separate benchmark hook processes. */
export function readJevUsageFile(file: string): JevTokenUsage {
  const usage: JevTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, missingCalls: 0 };
  if (!existsSync(file)) return usage;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { addUsage(usage, JSON.parse(line) as { inputTokens?: number; outputTokens?: number; totalTokens?: number }); }
    catch { usage.calls += 1; usage.missingCalls += 1; }
  }
  return usage;
}
