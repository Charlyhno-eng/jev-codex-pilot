import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { CodexStatusSnapshot, CodexStatusWindow } from "./types.js";

type JsonObject = Record<string, any>;

/** Extracts the last reported context size from a Codex rollout. */
export async function readCodexContext(path: string): Promise<CodexStatusSnapshot["context"]> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let context: CodexStatusSnapshot["context"];
  try {
    for await (const line of lines) {
      if (!line.includes('"token_count"')) continue;
      let event: JsonObject;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.payload?.type !== "token_count") continue;
      const used = event.payload.info?.last_token_usage?.input_tokens;
      const size = event.payload.info?.model_context_window;
      if (Number.isFinite(used) && Number.isFinite(size) && size > 0) context = { usedTokens: Math.max(0, used), windowTokens: size };
    }
  } catch { return undefined; }
  return context;
}

/** Maps Codex quota windows to the 5-hour and weekly status fields. */
export function codexQuotaWindows(result: JsonObject): Pick<CodexStatusSnapshot, "fiveHour" | "weekly"> {
  const bucket = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
  const windows = [bucket?.primary, bucket?.secondary].filter(Boolean) as JsonObject[];
  const mapWindow = (minutes: number): CodexStatusWindow | undefined => {
    const window = windows.find(value => value.windowDurationMins === minutes);
    if (!window || !Number.isFinite(window.usedPercent)) return undefined;
    const reset = Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000) : undefined;
    return { remainingPercent: Math.max(0, Math.min(100, Math.round(100 - window.usedPercent))), resetsAt: reset && !Number.isNaN(reset.getTime()) ? reset.toISOString() : undefined };
  };
  return { fiveHour: mapWindow(300), weekly: mapWindow(10_080) };
}

/** Captures a best-effort Codex status snapshot after a ticket. */
export async function readCodexStatusSnapshot(threadId?: string): Promise<CodexStatusSnapshot> {
  const capturedAt = new Date().toISOString();
  return new Promise(resolve => {
    const child = spawn("codex", ["app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
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
      let message: JsonObject;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 0 && message.error) { error = message.error.message; void finish(); return; }
      if (message.id === 0 && message.result) {
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: 1, params: {} });
        if (threadId) send({ method: "thread/read", id: 2, params: { threadId, includeTurns: false } });
      }
      if (message.id === 1) { limitDone = true; if (message.result) limits = codexQuotaWindows(message.result); else error = message.error?.message; }
      if (message.id === 2) { threadDone = true; rolloutPath = typeof message.result?.thread?.path === "string" ? message.result.thread.path : undefined; }
      if (limitDone && threadDone) void finish();
    });
    child.on("error", cause => { error = cause.message; void finish(); });
    child.on("close", () => { if (!settled) void finish(); });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "jev_codex_pilot", title: "JEV Codex Pilot", version: "0.2.0" } } });
  });
}
