import { closeSync, openSync, readSync, statSync } from "node:fs";
import { logJevError } from "../jev-logger.js";
import type { JevHookClient } from "./jev-client.js";
import type { HookEvent, PureAnswer, PureQuestion } from "./types.js";

export type DietAction = "keep" | "truncate" | "drop";
export type DietDecision = { action: DietAction; confidence: number };
const CRITICAL = /(?:error|failed|failure|exception|assertion|\btests? passed\b|\b\d+ passed\b|\bexit[_ ]?code\b|(?:^|[\s"'])[\w./-]+\.(?:ts|tsx|js|json|py|md|toml|yml|yaml|rs|go)\b)/i;
const MIN_CONFIDENCE = 0.8;

function serialize(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function redact(text: string): string {
  return text.replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*(?:'[^']*'|"[^"]*"|\S+)/gi, "$1=[REDACTED]")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [REDACTED]");
}

/** Keeps beginning, end, and important lines of a result. */
export function smartTruncate(text: string, limit = 2_400): string {
  if (text.length <= limit) return text;
  const important = text.split("\n").filter(line => CRITICAL.test(line)).slice(0, 12).map(line => line.slice(0, 220)).join("\n");
  const head = text.slice(0, Math.floor(limit * 0.3));
  const tail = text.slice(-Math.floor(limit * 0.3));
  return `${head}\n[${text.length - head.length - tail.length} characters omitted]\n${important ? `${important}\n` : ""}${tail}`.slice(0, limit + 600);
}

/** Batch scores tool results or transcript messages with one TypeSafe request per batch. */
export async function judgeDiet(items: string[], client: JevHookClient, timeoutMs = 1_500, context?: string): Promise<DietDecision[]> {
  if (!items.length) return [];
  const controller = new AbortController();
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error("JEV timed out")); }, timeoutMs);
  try {
    if (!client.evaluateBatch) throw new Error("Batch evaluation unavailable");
    const questions: PureQuestion[] = items.map((_, index) => ({
      kind: "Choice", id: `item_${index}`,
      criteria: {
        keep: "Critical information or directly relevant content: retain verbatim.",
        truncate: "Useful content with redundancy: retain an accurate shortened version.",
        drop: "Superseded or irrelevant content with no facts needed later."
      },
      instructions: "Protect errors, relevant file paths, test results, user requirements, decisions, and unresolved work. Prefer keep if uncertain."
    }));
    const answers = await Promise.race([client.evaluateBatch(JSON.stringify({ context: redact(context ?? "").slice(0, 2_000), items: items.map((content, index) => ({ id: `item_${index}`, content: redact(content.slice(0, 1_500)) })) }), questions, controller.signal), timeout]);
    return items.map((content, index) => {
      const answer: PureAnswer | undefined = answers[`item_${index}`];
      if (!answer || answer.kind !== "Choice" || !["keep", "truncate", "drop"].includes(answer.value) || answer.confidence < MIN_CONFIDENCE) return { action: "keep", confidence: answer?.confidence ?? 0 };
      // An evaluator cannot discard key diagnostics or the only reference to a file.
      if (CRITICAL.test(content) && answer.value === "drop") return { action: "keep", confidence: answer.confidence };
      return { action: answer.value as DietAction, confidence: answer.confidence };
    });
  } catch {
    return items.map(() => ({ action: "keep", confidence: 0 }));
  } finally {
    clearTimeout(timer);
  }
}

/** Replaces a large tool result only when JEV confidently removes redundant content. */
export async function postToolUse(event: HookEvent, client: JevHookClient): Promise<object> {
  const original = serialize(event.tool_response);
  if (!original.trim()) return {};
  if (/\b(?:api[_-]?key|token|secret|password|authorization)\b|(?:^|[\s/])\.env(?:[\s/.]|$)/i.test(original)) {
    logJevError(`PostToolUse context diet · ${event.tool_name ?? "tool"} · preserved sensitive result`);
    return {};
  }
  const parts = original.match(/[\s\S]{1,1800}/g) ?? [];
  if (parts.length > 50) {
    logJevError(`PostToolUse context diet · ${event.tool_name ?? "tool"} · preserved oversized result (${original.length} characters)`);
    return {}; // Large unknown output is left intact on timeout or budget overflow.
  }
  const context = JSON.stringify({ tool: event.tool_name, input: redact(serialize(event.tool_input)).slice(0, 1_000), task: redact(process.env.JEV_HOOK_TASK ?? "").slice(0, 1_000) });
  const decisions = await judgeDiet(parts, client, 1_500, context);
  if (decisions.every(decision => decision.action === "keep")) {
    logJevError(`PostToolUse context diet · ${event.tool_name ?? "tool"} · reviewed ${parts.length} part${parts.length === 1 ? "" : "s"} · kept`);
    return {};
  }
  const selected = parts.map((part, index) => decisions[index].action === "drop" ? "" : decisions[index].action === "truncate" ? smartTruncate(part, 500) : part).filter(Boolean).join("\n");
  // Use the full result for critical diagnostics, as a chunk boundary may split a path or test line.
  const reduced = smartTruncate(CRITICAL.test(original) ? original : selected, 2_600);
  if (reduced.length >= original.length * 0.8) {
    logJevError(`PostToolUse context diet · ${event.tool_name ?? "tool"} · reviewed ${parts.length} parts · reduction not worthwhile`);
    return {};
  }
  logJevError(`PostToolUse context diet · ${event.tool_name ?? "tool"} · ${original.length} → ${reduced.length} characters · ${decisions.filter(item => item.action === "drop").length} dropped`);
  return { continue: false, stopReason: reduced || "JEV found no relevant result content.", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: reduced || "JEV found no relevant result content." } };
}

/** Reviews up to 200 transcript entries before compaction without editing Codex state. */
export async function preCompact(event: HookEvent, client: JevHookClient): Promise<object> {
  const path = event.transcript_path;
  if (!path) return {};
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    let tail: string;
    try {
      const length = Math.min(size, 500_000);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      tail = buffer.toString("utf8");
    } finally { closeSync(fd); }
    const entries = tail.split("\n").slice(1, -1).slice(-200).map(line => {
      try { return JSON.stringify(JSON.parse(line)).slice(0, 1_500); } catch { return line.slice(0, 1_500); }
    });
    if (!entries.length) return {};
    const batches = await Promise.all(Array.from({ length: Math.ceil(entries.length / 50) }, (_, index) => judgeDiet(entries.slice(index * 50, index * 50 + 50), client, 1_500, `Codex transcript before ${event.trigger ?? "unknown"} compaction. Task: ${process.env.JEV_HOOK_TASK ?? ""}`)));
    const decisions = batches.flat();
    const counts = { keep: 0, truncate: 0, drop: 0 };
    for (const decision of decisions) counts[decision.action]++;
    logJevError(`PreCompact context review · ${entries.length} messages · keep ${counts.keep} · truncate ${counts.truncate} · drop ${counts.drop}`);
    // PreCompact has no native transcript rewrite field. This is an advisory report.
    return { systemMessage: `JEV reviewed ${entries.length} transcript entries before compaction: ${counts.keep} keep, ${counts.truncate} shorten, ${counts.drop} obsolete. Preserve errors, file paths, tests, and user requirements.` };
  } catch {
    logJevError("PreCompact context diet · fail open (transcript unavailable)");
    return {};
  }
}
