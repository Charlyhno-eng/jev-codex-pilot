import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { projectCodexEnv, projectCodexStateArgs } from "./home.js";
import { codexHookArgs } from "./hooks.js";
import { ticketJevUsageEnv } from "../../jev-usage.js";
import type { AccountUsage } from "../../types.js";
import type { ExecutionRateLimit } from "../types.js";
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
function objectValue(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function parseObject(line: string): Record<string, unknown> | undefined { try { return objectValue(JSON.parse(line)); } catch { return undefined; } }
function protocolError(value: unknown, fallback: string): string { const error = objectValue(value)?.message; return typeof error === "string" ? error : fallback; }
/** Detects whether a Codex compaction event completed. */
export function isCompactionComplete(message: Record<string, unknown>) {
  const item = (message.params as { item?: { type?: unknown } } | undefined)?.item;
  return (message.method === "item/completed" || message.method === "item.completed") && item?.type === "contextCompaction";
}

function isCompactionFailure(message: Record<string, unknown>) {
  const turn = (message.params as { turn?: { status?: unknown } } | undefined)?.turn;
  return (message.method === "turn/completed" || message.method === "turn.completed") && turn?.status === "failed";
}

/** Compacts one Codex thread through its native lifecycle. */
export function compactThread(threadId: string, home: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", [...projectCodexStateArgs(home), ...codexHookArgs(), "app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...projectCodexEnv(home), ...ticketJevUsageEnv() } });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Codex compaction timed out after 5 minutes")), 300_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.kill(); if (error) reject(error); else resolve(); };
    lines.on("line", line => {
      const message = parseObject(line);
      if (!message) return;
      if (message.id === 0 && message.error) return finish(new Error(protocolError(message.error, "Could not initialize Codex app server")));
      if (message.id === 0 && objectValue(message.result)) { send({ method: "initialized", params: {} }); send({ method: "thread/resume", id: 1, params: { threadId } }); }
      if (message.id === 1 && objectValue(objectValue(message.result)?.thread)) send({ method: "thread/compact/start", id: 2, params: { threadId } });
      if (message.id === 1 && message.error) return finish(new Error(protocolError(message.error, "Could not resume Codex thread")));
      if (message.id === 2 && message.error) return finish(new Error(protocolError(message.error, "Could not compact Codex thread")));
      if (isCompactionComplete(message)) finish();
      if (isCompactionFailure(message)) finish(new Error("Codex compaction failed"));
    });
    child.on("error", finish);
    child.stdin.on("error", error => finish(error));
    child.on("close", code => { if (!settled) finish(new Error(`Codex app server exited with code ${code} before confirming compaction`)); });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "jev_codex_pilot", title: "JEV Codex Pilot", version: "0.2.0" } } });
  });
}

/** Archives one Codex thread through its native lifecycle. */
export function archiveThread(threadId: string, home: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", [...projectCodexStateArgs(home), "app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...projectCodexEnv(home), ...ticketJevUsageEnv() } });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Codex thread clear timed out")), 30_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.kill(); if (error) reject(error); else resolve(); };
    lines.on("line", line => {
      const message = parseObject(line);
      if (!message) return;
      if (message.id === 0 && message.error) return finish(new Error(protocolError(message.error, "Could not initialize Codex app server")));
      if (message.id === 0 && objectValue(message.result)) { send({ method: "initialized", params: {} }); send({ method: "thread/archive", id: 1, params: { threadId } }); }
      if (message.id === 1 && message.error) return finish(new Error(protocolError(message.error, "Could not clear Codex thread")));
      if (message.id === 1 && message.result) finish();
    });
    child.on("error", finish);
    child.stdin.on("error", error => finish(error));
    child.on("close", code => { if (!settled) finish(new Error(`Codex app server exited with code ${code} before confirming thread archival`)); });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "jev_codex_pilot", title: "JEV Codex Pilot", version: "0.2.0" } } });
  });
}

/** Best effort only: this is Codex-account usage, never an attribution to one job. */
export function readAccountUsage(): Promise<AccountUsage> {
  return new Promise(resolve => {
    const capturedAt = new Date().toISOString();
    const child = spawn("codex", ["app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (snapshot: AccountUsage) => { if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.kill(); resolve(snapshot); };
    const timer = setTimeout(() => finish({ capturedAt, unavailableReason: "Codex account usage timed out." }), 2_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const asNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
    lines.on("line", line => {
      const message = parseObject(line);
      if (!message) return;
      if (message.id === 0 && message.error) return finish({ capturedAt, unavailableReason: protocolError(message.error, "Codex account usage is unavailable.") });
      if (message.id === 0 && objectValue(message.result)) { send({ method: "initialized", params: {} }); send({ method: "account/usage/read", id: 1, params: {} }); }
      if (message.id === 1 && message.error) return finish({ capturedAt, unavailableReason: protocolError(message.error, "Codex account usage is unavailable.") });
      const result = objectValue(message.result);
      if (message.id === 1 && result) {
        const summary = objectValue(result.summary) ?? {};
        const today = new Date().toISOString().slice(0, 10);
        const bucket = Array.isArray(result.dailyUsageBuckets) ? result.dailyUsageBuckets.map(objectValue).find(entry => entry?.startDate === today) : undefined;
        finish({ capturedAt, lifetimeTokens: asNumber(summary.lifetimeTokens), peakDailyTokens: asNumber(summary.peakDailyTokens), todayTokens: asNumber(bucket?.tokens) });
      }
    });
    child.on("error", error => finish({ capturedAt, unavailableReason: messageOf(error) }));
    child.stdin.on("error", error => finish({ capturedAt, unavailableReason: messageOf(error) }));
    child.on("close", code => { if (!settled) finish({ capturedAt, unavailableReason: code === 0 ? "Codex account usage is not available for this authentication mode." : `Codex app-server exited with code ${code}.` }); });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "jev_codex_pilot", title: "JEV Codex Pilot", version: "0.2.0" } } });
  });
}

/** Reads the Codex session quota without inferring limits from token totals. */
export function readExecutionRateLimit(): Promise<ExecutionRateLimit> {
  return new Promise(resolve => {
    const child = spawn("codex", ["app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout }); let settled = false;
    const finish = (value: ExecutionRateLimit) => { if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.kill(); resolve(value); };
    const timer = setTimeout(() => finish({ available: false, reached: false, unavailableReason: "Codex rate-limit check timed out." }), 2_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const asDate = (value: unknown) => {
      if (typeof value !== "number") return undefined;
      const date = new Date(value * 1_000);
      return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
    };
    lines.on("line", line => {
      const message = parseObject(line);
      if (!message) return;
      if (message.id === 0 && message.error) return finish({ available: false, reached: false, unavailableReason: protocolError(message.error, "Codex rate limits are unavailable.") });
      if (message.id === 0 && objectValue(message.result)) { send({ method: "initialized", params: {} }); send({ method: "account/rateLimits/read", id: 1, params: {} }); }
      if (message.id === 1 && message.error) return finish({ available: false, reached: false, unavailableReason: protocolError(message.error, "Codex rate limits are unavailable.") });
      const result = objectValue(message.result);
      if (message.id === 1 && result) {
        const rateLimits = objectValue(result.rateLimitsByLimitId) ?? { codex: result.rateLimits };
        const values = Object.values(rateLimits).map(objectValue).filter((limit): limit is Record<string, unknown> => Boolean(limit));
        const windows = values.flatMap(limit => [objectValue(limit.primary), objectValue(limit.secondary)].filter((window): window is Record<string, unknown> => Boolean(window)));
        const reached = values.some(limit => Boolean(limit.rateLimitReachedType)) || windows.some(window => Number(window.usedPercent) >= 100);
        const reachedWindows = values.flatMap(limit => {
          const named = limit.rateLimitReachedType === "primary" ? objectValue(limit.primary) : limit.rateLimitReachedType === "secondary" ? objectValue(limit.secondary) : undefined;
          const exhausted = [objectValue(limit.primary), objectValue(limit.secondary)].filter((window): window is Record<string, unknown> => Boolean(window && Number(window.usedPercent) >= 100));
          return named ? [named] : exhausted;
        });
        const resets = (reachedWindows.length ? reachedWindows : windows).map(window => asDate(window.resetsAt)).filter((value): value is string => Boolean(value)).sort();
        finish({ available: true, reached, resetsAt: resets.at(-1) });
      }
    });
    child.on("error", error => finish({ available: false, reached: false, unavailableReason: messageOf(error) }));
    child.stdin.on("error", error => finish({ available: false, reached: false, unavailableReason: messageOf(error) }));
    child.on("close", code => { if (!settled) finish({ available: false, reached: false, unavailableReason: code === 0 ? "Codex rate limits are unavailable for this authentication mode." : `Codex app-server exited with code ${code}.` }); });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "jev_codex_pilot", title: "JEV Codex Pilot", version: "0.2.0" } } });
  });
}

