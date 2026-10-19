import type { ExecutionEvent, ExecutionPhase } from "../../types.js";
/** Native JSONL envelope consumed only by the Codex adapter. */
export type CodexJsonEvent = Record<string, unknown> & { type?: string; item?: Record<string, unknown> };
type JsonEvent = CodexJsonEvent;
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 4000);
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value).slice(0, 4000);
}
/** Converts a native Codex event into a provider-independent progress update. */
export function describeCodexEvent(event: JsonEvent): { phase: ExecutionPhase; item?: Omit<ExecutionEvent, "id" | "timestamp">; threadId?: string } {
  const type = event.type ?? "event";
  const item = event.item ?? {};
  const itemType = String(item.type ?? "");
  if (type === "thread.started") return { phase: "STARTING", threadId: text(event.thread_id), item: { kind: "system", title: "Codex session started", status: "success" } };
  if (type === "turn.started") return { phase: "THINKING", item: { kind: "reasoning", title: "Reading the project and planning the work", status: "active" } };
  if (type === "turn.completed") return { phase: "FINISHING", item: { kind: "system", title: "Codex finished its turn", detail: text(event.usage), status: "success" } };
  if (type === "turn.failed" || type === "error") return { phase: "ERROR", item: { kind: "error", title: "Codex reported an error", detail: text(event.error ?? event.message), status: "error" } };
  if (type === "item.started" && itemType === "command_execution") return { phase: "WORKING", item: { kind: "command", title: "Running a command", detail: text(item.command), status: "active" } };
  if (type === "item.completed" && itemType === "command_execution") {
    const failed = typeof item.exit_code === "number" && item.exit_code !== 0;
    return { phase: "WORKING", item: { kind: "command", title: failed ? "Command failed" : "Command completed", detail: text(item.command ?? item.aggregated_output), status: failed ? "error" : "success" } };
  }
  if (type === "item.completed" && /file|change|patch/i.test(itemType)) return { phase: "WORKING", item: { kind: "file", title: "Project files updated", detail: text(item.path ?? item.changes ?? item), status: "success" } };
  if (type === "item.completed" && itemType === "agent_message") return { phase: "WORKING", item: { kind: "message", title: "Codex update", detail: text(item.text), status: "success" } };
  if (type === "item.completed" && /reason/i.test(itemType)) return { phase: "THINKING", item: { kind: "reasoning", title: "Reasoning step completed", detail: text(item.text), status: "success" } };
  if (type === "item.started" && /mcp|tool/i.test(itemType)) return { phase: "WORKING", item: { kind: "command", title: "Calling a tool", detail: text(item.name ?? item.server), status: "active" } };
  if (type === "item.completed" && /mcp|tool/i.test(itemType)) return { phase: "WORKING", item: { kind: "command", title: "Tool call completed", detail: text(item.name ?? item.result), status: "success" } };
  if (type === "item.completed" && /web_search/i.test(itemType)) return { phase: "WORKING", item: { kind: "message", title: "Web search completed", detail: text(item.query), status: "success" } };
  if (type === "item.completed" && /todo/i.test(itemType)) return { phase: "WORKING", item: { kind: "message", title: "Work plan updated", detail: text(item.items ?? item), status: "success" } };
  if (type === "item.started" && /reason/i.test(itemType)) return { phase: "THINKING", item: { kind: "reasoning", title: "Codex is reasoning", status: "active" } };
  if (type === "raw") return { phase: "WORKING", item: { kind: "message", title: "Codex diagnostic", detail: text(event.message), status: "active" } };
  return { phase: "WORKING" };
}

