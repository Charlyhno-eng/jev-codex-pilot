import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface JevTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  calls: number;
  missingCalls: number;
}

const ticketCollector = new AsyncLocalStorage<string>();

function addUsage(active: JevTokenUsage, usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void {
  active.calls += 1;
  if (!usage || typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") { active.missingCalls += 1; return; }
  active.inputTokens += usage.inputTokens;
  active.outputTokens += usage.outputTokens;
  active.totalTokens += usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
}

/** Records one JEV provider response in the current ticket telemetry file. */
export function recordJevUsage(usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void {
  const ticketFile = ticketCollector.getStore() ?? process.env.JEV_TICKET_USAGE_FILE;
  if (ticketFile) {
    try { appendFileSync(ticketFile, `${JSON.stringify(usage ?? {})}\n`, { encoding: "utf8", mode: 0o600 }); }
    catch { /* Telemetry never changes a JEV decision. */ }
  }
}

/** Reads token-only records written by ticket evaluation and Codex hook processes. */
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

/** Associates provider calls and inherited hook telemetry with one ticket. */
export async function withTicketJevUsage<T>(file: string, run: () => Promise<T>): Promise<T> {
  return ticketCollector.run(file, run);
}

/** Supplies the current ticket telemetry path to a Codex child process. */
export function ticketJevUsageEnv(): Record<string, string> {
  const file = ticketCollector.getStore();
  return file ? { JEV_TICKET_USAGE_FILE: file } : {};
}
