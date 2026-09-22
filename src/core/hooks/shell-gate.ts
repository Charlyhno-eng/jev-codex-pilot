import { createHash } from "node:crypto";
import { logJevError } from "../jev-logger.js";
import type { JevHookClient } from "./jev-client.js";
import { offloadDecisions } from "./offload.js";
import type { HookEvent } from "./types.js";

export type GateResult = { action: "allow" | "deny" | "confirm"; reason: string; risk?: number; confidence?: number };

function shellCommand(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  return typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : undefined;
}

/** Removes common credential forms before sending commands to JEV. */
function redact(command: string): string {
  return command
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*=\s*(?:'[^']*'|"[^"]*"|\S+)/gi, "$1=[REDACTED]")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [REDACTED]")
    .slice(0, 8_000);
}

/** Evaluates a supported shell call and fails open when JEV cannot decide. */
export async function gateShell(event: HookEvent, client: JevHookClient): Promise<GateResult> {
  const command = shellCommand(event.tool_input);
  if (!command) return { action: "allow", reason: "No shell command in hook input" };
  const id = createHash("sha256").update(command).digest("hex").slice(0, 10);
  const state = JSON.stringify({ command: redact(command), cwd: event.cwd, task: redact(process.env.JEV_HOOK_TASK ?? "").slice(0, 2_000), permissionMode: (event as HookEvent & { permission_mode?: string }).permission_mode });
  const answers = await offloadDecisions(state, [
    { kind: "Noul", id: "in_scope", criteria: "This command is relevant to the user's current task and within its authorized scope.", instructions: "Answer only the yes/no scope judgment." },
    { kind: "Score", id: "risk", criteria: ["Read-only or negligible risk.", "Routine reversible local change.", "Moderate side effects that are within scope.", "Potentially destructive or external side effects.", "Clearly destructive, credential exposing, or unauthorized."], instructions: "Score the command's risk from 0 to 4." },
    {
      kind: "Choice", id: "shell_gate",
      criteria: {
        allow: "Relevant command within the user's requested task, with acceptable effects.",
        deny: "Clearly dangerous, destructive, credential exposing, or outside the user's authorized scope.",
        confirm: "Potentially legitimate, but requires an explicit user decision before execution."
      },
      instructions: "Judge the pending command, its working directory, risk and task relevance. Do not approve a destructive or unrelated action. Use confirm for uncertain authorization. This is a judgment only; do not execute or generate code."
    }
  ], client, 0.75);
  const choice = answers.shell_gate;
  const scope = answers.in_scope;
  const risk = answers.risk;
  const decision: GateResult = choice?.kind === "jev" && choice.answer.kind === "Choice" && scope?.kind === "jev" && scope.answer.kind === "Noul" && risk?.kind === "jev" && risk.answer.kind === "Score"
    ? { action: choice.answer.value === "deny" || risk.answer.value === 4 ? "deny" : choice.answer.value === "allow" && (!scope.answer.value || risk.answer.value === 3) ? "confirm" : choice.answer.value as GateResult["action"], reason: choice.answer.value === "deny" || risk.answer.value === 4 ? "JEV identified a dangerous or out-of-scope command" : choice.answer.value === "confirm" || !scope.answer.value || risk.answer.value === 3 ? "JEV requests user confirmation for this command" : "JEV approved the command", confidence: Math.min(choice.answer.confidence, scope.answer.confidence, risk.answer.confidence), risk: risk.answer.value }
    : { action: "allow", reason: "Fail open: JEV unavailable or insufficient confidence" };
  logJevError(`PreToolUse shell gate · ${id} · ${decision.action} · ${decision.reason}${decision.confidence === undefined ? "" : ` · confidence ${decision.confidence.toFixed(2)}`}`);
  return decision;
}

/** Converts the gate decision to the supported native PreToolUse response. */
export function preToolUseOutput(result: GateResult): object {
  if (result.action === "allow") return {};
  const reason = result.action === "confirm"
    ? "JEV requires confirmation. Ask the user explicitly, then retry the command after authorization."
    : result.reason;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}
