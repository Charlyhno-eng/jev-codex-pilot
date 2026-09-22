import React from "react";
import type { CodexStatusSnapshot } from "../lib/types.js";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function resetLabel(value?: string) {
  if (!value) return "Reset time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  return `Resets ${date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
}

/** Shows the Codex status captured when a ticket finishes. */
export function CodexStatusPanel({ status }: { status: CodexStatusSnapshot }) {
  const context = status.context;
  const contextLeft = context ? Math.max(0, Math.min(100, Math.round(100 * (1 - context.usedTokens / context.windowTokens)))) : undefined;
  const rows = [
    { label: "Context window", value: contextLeft, detail: context ? `${compact.format(context.usedTokens)} used / ${compact.format(context.windowTokens)}` : "Unavailable" },
    { label: "5h limit", value: status.fiveHour?.remainingPercent, detail: status.fiveHour ? resetLabel(status.fiveHour.resetsAt) : "Unavailable" },
    { label: "Weekly limit", value: status.weekly?.remainingPercent, detail: status.weekly ? resetLabel(status.weekly.resetsAt) : "Unavailable" }
  ];
  return <section className="codex-status-panel"><div className="codex-status-heading"><p className="panel-label">CODEX STATUS AFTER TICKET</p><small>Captured {new Date(status.capturedAt).toLocaleString()} · account limits are shared across projects</small></div><div className="codex-status-rows">{rows.map(row => <div className="codex-status-row" key={row.label}><b>{row.label}</b><div className="codex-status-track"><span style={{ width: `${row.value ?? 0}%` }}/></div><strong>{row.value === undefined ? "—" : `${row.value}% left`}</strong><small>{row.detail}</small></div>)}</div>{status.unavailableReason && <p>{status.unavailableReason}</p>}</section>;
}
