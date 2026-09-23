import React, { useEffect, useMemo, useRef } from "react";
import type { ExecutionEvent, Job } from "../lib/types.js";
import { formatNumber, reasoningLabel, verificationLabel } from "../lib/format.js";
import { CodexStatusPanel } from "./CodexStatusPanel.js";

type Activity = { id: string; timestamp?: string; title: string; detail?: string; tone: "jev" | "route" | "command" | "complete" | "error" };

/** Shows the decision trail and raw Codex output for one ticket. */
export function ExecutionPanel({ job }: { job: Job }) {
  const execution = job.execution;
  const consoleRef = useRef<HTMLPreElement>(null);
  const consoleText = useMemo(() => formatCodexConsole(job.output ?? ""), [job.output]);
  const activity = useMemo(() => execution ? buildActivity(job, execution.events) : [], [job, execution]);
  const latestRoute = execution?.metrics?.routes.at(-1);
  useEffect(() => { if (job.status === "RUNNING") consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight }); }, [consoleText, job.status]);

  return <div className="execution-panel execution-dashboard">
    <section className="execution-overview">
      <div><p className="panel-label">DEVELOPMENT STATUS</p><h3>{statusTitle(job.status, execution?.verification)}</h3><span>{execution?.completedAt ? `Finished ${new Date(execution.completedAt).toLocaleString()}` : execution ? `Started ${new Date(execution.startedAt).toLocaleString()}` : "Waiting for Codex"}</span></div>
      {execution && <div className="execution-facts">
        <span><small>MODEL</small><b>{latestRoute?.model ?? execution.model}</b></span>
        <span><small>REASONING</small><b>{reasoningLabel(latestRoute?.reasoning ?? execution.reasoning)}</b></span>
        <span><small>VALIDATION</small><b>{verificationLabel(execution.verification)}</b></span>
        <span><small>ACTUAL TOKENS</small><b>{formatNumber(execution.metrics?.actualTokens ?? execution.usage?.input_tokens)}</b></span>
      </div>}
    </section>
    {execution && <CodexStatusPanel status={execution.codexStatus}/>}
    {job.error && <div className="execution-error"><b>{issueLabel(job.errorCategory)}</b><span>{job.error}</span></div>}
    {job.recoveryNote && <div className="verification-note"><b>Interrupted execution</b><span>{job.recoveryNote}</span></div>}
    {job.status === "SESSION_PAUSED" && <div className="verification-note"><b>Codex quota reached</b><span>{job.sessionResumeAt ? `Development will resume after ${new Date(job.sessionResumeAt).toLocaleString()}.` : "Development will resume when the next Codex session is available."}</span></div>}
    {execution?.verificationNote && <div className="verification-note"><b>{job.errorCategory === "dependency" ? "Missing verification dependency" : "Verification note"}</b><span>{execution.verificationNote}</span></div>}
    {job.notificationError && <div className="verification-note"><b>Telegram notification failed</b><span>{job.notificationError}</span></div>}
    {execution && <section className="execution-activity">
      <header><div><p className="panel-label">JEV ACTIVITY</p><h4>Decisions and development log</h4></div><span>{activity.length} events</span></header>
      <div className="activity-list">{activity.map(item => <article className={`activity-event ${item.tone}`} key={item.id}><i>{activityIcon(item.tone)}</i><div><div><b>{item.title}</b>{item.timestamp && <time>{new Date(item.timestamp).toLocaleTimeString()}</time>}</div>{item.detail && <p>{item.detail}</p>}</div></article>)}</div>
    </section>}
    <details className="raw-console" open={job.status === "RUNNING"}><summary>Raw Codex console {job.status === "RUNNING" ? "· streaming" : ""}</summary><div className="live-console"><pre ref={consoleRef}>{consoleText || "Waiting for the first Codex event…"}{job.status === "RUNNING" && <span className="console-cursor">▋</span>}</pre></div></details>
    {job.output && <details className="raw-output"><summary>View raw Codex JSONL output</summary><pre>{job.output}</pre></details>}
  </div>;
}

function buildActivity(job: Job, events: ExecutionEvent[]): Activity[] {
  const result: Activity[] = [];
  if (job.analysis) {
    result.push({ id: "jev-recommendation", title: "JEV recommendation applied", detail: `${job.analysis.model} · ${reasoningLabel(job.analysis.reasoning)} reasoning`, tone: "jev" });
    if (job.analysis.context_files.length) result.push({ id: "jev-context", title: "Files selected for Codex context", detail: job.analysis.context_files.join(", "), tone: "jev" });
  }
  for (const event of events) if (isVisibleActivity(event)) result.push({ id: event.id, timestamp: event.timestamp, title: event.title, detail: compactDetail(event.detail), tone: activityTone(event) });
  if (job.error && !result.some(item => item.tone === "error")) result.push({ id: "execution-error", title: "Development stopped with an error", detail: job.error, tone: "error" });
  return result;
}

function isVisibleActivity(event: ExecutionEvent) { return event.title !== "Starting Codex" && event.title !== "Codex status checkpoint" && (event.kind === "command" || event.kind === "file" || event.kind === "error" || event.kind === "system"); }
function activityTone(event: ExecutionEvent): Activity["tone"] { if (event.kind === "error" || event.status === "error") return "error"; if (event.kind === "command") return "command"; if (/model changed|reasoning changed|routing|compact|clear/i.test(event.title)) return "route"; if (/completed|execution completed|verification satisfied/i.test(event.title)) return "complete"; return "jev"; }
function activityIcon(tone: Activity["tone"]) { return tone === "command" ? ">_" : tone === "route" ? "↗" : tone === "complete" ? "✓" : tone === "error" ? "!" : "J"; }
function compactDetail(detail?: string) { return detail?.length && detail.length > 1400 ? `${detail.slice(0, 1400)}…` : detail; }
function statusTitle(status: string, verification?: string) { if (status === "PENDING") return "Ready to resume"; if (status === "RUNNING") return "Development in progress"; if (status === "SESSION_PAUSED") return "Development paused"; if (status === "FAILED") return "Development needs attention"; return verification === "environment_blocked" ? "Development completed · checks partly blocked" : "Development completed"; }
function issueLabel(category?: Job["errorCategory"]) { return ({ code: "Code failure", verification: "Verification unavailable", dependency: "Missing dependency", codex: "Codex error", loop: "Repetition loop stopped", quota: "Codex quota reached", interruption: "Server interruption", telegram: "Telegram error", jev: "JEV analysis error" } as Record<string, string>)[category ?? ""] ?? "Execution error"; }

function formatCodexConsole(output: string) { return output.split("\n").filter(Boolean).map(line => { if (/^Reading additional input from stdin/i.test(line)) return ""; try { const event = JSON.parse(line) as any; const item = event.item ?? {}; if (event.type === "thread.started") return `● Session started  ${event.thread_id ?? ""}`; if (event.type === "turn.started") return "✦ Codex is reading the project and planning…"; if (event.type === "turn.completed") return `✓ Turn completed  ${JSON.stringify(event.usage ?? {})}`; if (event.type === "turn.failed" || event.type === "error") return `! ERROR  ${JSON.stringify(event.error ?? event.message ?? event)}`; if (item.type === "command_execution") { const command = String(item.command ?? ""); const result = String(item.aggregated_output ?? "").trim().slice(-4000); return item.status === "in_progress" ? `$ ${command}` : result || `✓ Command finished with exit code ${String(item.exit_code ?? 0)}`; } if (item.type === "agent_message") return String(item.text ?? ""); if (/reason/i.test(item.type ?? "")) return `◆ ${String(item.text ?? "Reasoning…")}`; if (/file|change|patch/i.test(item.type ?? "")) return `◇ Files changed  ${JSON.stringify(item.changes ?? item.path ?? item).slice(0, 4000)}`; return ""; } catch { return line.slice(0, 4000); } }).filter(Boolean).join("\n\n"); }
