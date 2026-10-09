import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { projectCodexEnv, projectCodexStateArgs } from "./codex-home.js";
import type { CodexStatusSnapshot, CodexStatusWindow } from "./types.js";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function parseObject(line: string): JsonObject | undefined {
  try { return objectValue(JSON.parse(line)); } catch { return undefined; }
}

function protocolError(value: unknown, fallback: string): string {
  const error = objectValue(value)?.message;
  return typeof error === "string" ? error : fallback;
}

/** Extracts the last reported context size from a Codex rollout. */
export async function readCodexContext(path: string): Promise<CodexStatusSnapshot["context"]> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let context: CodexStatusSnapshot["context"];
  try {
    for await (const line of lines) {
      if (!line.includes('"token_count"')) continue;
      const event = parseObject(line);
      const payload = objectValue(event?.payload);
      if (payload?.type !== "token_count") continue;
      const info = objectValue(payload.info);
      const lastUsage = objectValue(info?.last_token_usage);
      const used = lastUsage?.input_tokens;
      const size = info?.model_context_window;
      if (typeof used === "number" && Number.isFinite(used) && typeof size === "number" && Number.isFinite(size) && size > 0) {
        context = { usedTokens: Math.max(0, used), windowTokens: size };
      }
    }
  } catch { return undefined; }
  return context;
}

/** Maps Codex quota windows to the 5-hour and weekly status fields. */
export function codexQuotaWindows(result: JsonObject): Pick<CodexStatusSnapshot, "fiveHour" | "weekly"> {
  const limitsById = objectValue(result.rateLimitsByLimitId);
  const bucket = objectValue(limitsById?.codex) ?? objectValue(result.rateLimits);
  const windows = [objectValue(bucket?.primary), objectValue(bucket?.secondary)].filter((window): window is JsonObject => Boolean(window));
  const mapWindow = (minutes: number): CodexStatusWindow | undefined => {
    const window = windows.find(value => value.windowDurationMins === minutes);
    const usedPercent = window?.usedPercent;
    if (!window || typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
    const resetsAt = window.resetsAt;
    const reset = typeof resetsAt === "number" && Number.isFinite(resetsAt) ? new Date(resetsAt * 1000) : undefined;
    return { remainingPercent: Math.max(0, Math.min(100, Math.round(100 - usedPercent))), resetsAt: reset && !Number.isNaN(reset.getTime()) ? reset.toISOString() : undefined };
  };
  return { fiveHour: mapWindow(300), weekly: mapWindow(10_080) };
}

/** Captures a best-effort Codex status snapshot after a ticket. */
export async function readCodexStatusSnapshot(threadId?: string, home?: string): Promise<CodexStatusSnapshot> {
  const capturedAt = new Date().toISOString();
  return new Promise(resolve => {
    const child = spawn("codex", [...(home ? projectCodexStateArgs(home) : []), "app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: home ? projectCodexEnv(home) : process.env });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let limits: Pick<CodexStatusSnapshot, "fiveHour" | "weekly"> = {};
    let rolloutPath: string | undefined;
    let limitDone = false;
    let threadDone = !threadId;
    let error: string | undefined;
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      const context = rolloutPath ? await readCodexContext(rolloutPath) : undefined;
      resolve({ capturedAt, ...limits, context, unavailableReason: !context && !limits.fiveHour && !limits.weekly ? error ?? "Codex status is unavailable." : undefined });
    };
    const timer = setTimeout(() => { error = "Codex status timed out."; void finish(); }, 3_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    lines.on("line", line => {
      const message = parseObject(line);
      if (!message) return;
      if (message.id === 0 && message.error) { error = protocolError(message.error, "Codex status is unavailable."); void finish(); return; }
      if (message.id === 0 && message.result) {
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: 1, params: {} });
        if (threadId) send({ method: "thread/read", id: 2, params: { threadId, includeTurns: false } });
      }
      if (message.id === 1) {
        limitDone = true;
        const result = objectValue(message.result);
        if (result) limits = codexQuotaWindows(result);
        else error = protocolError(message.error, "Codex rate limits are unavailable.");
      }
      if (message.id === 2) {
        threadDone = true;
        const path = objectValue(objectValue(message.result)?.thread)?.path;
        rolloutPath = typeof path === "string" ? path : undefined;
      }
      if (limitDone && threadDone) void finish();
    });
    child.on("error", cause => { error = cause.message; void finish(); });
    child.on("close", () => { if (!settled) void finish(); });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "jev_codex_pilot", title: "JEV Codex Pilot", version: "0.2.0" } } });
  });
}
