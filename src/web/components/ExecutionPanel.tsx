import { useEffect, useMemo, useRef } from "react";
import type { ExecutionEvent, Job } from "../lib/types.js";
import { formatNumber, reasoningLabel } from "../lib/format.js";
import { TicketIssue } from "./TicketIssue.js";
import { ExecutionStatusPanel } from "./ExecutionStatusPanel.js";
import { formatExecutionConsole } from "../../core/execution/console.js";

type Activity = { id: string; timestamp?: string; title: string; detail?: string; tone: "jev" | "route" | "command" | "complete" | "error" };

/** Shows the decision trail and raw provider output for one ticket. */
export function ExecutionPanel({ job }: { job: Job }) {
  const execution = job.execution;
  const providerName = execution?.providerName ?? "Codex";
  const consoleRef = useRef<HTMLPreElement>(null);
  const consoleText = useMemo(() => formatExecutionConsole(job.output ?? "", execution?.providerId), [job.output, execution?.providerId]);
  const activity = useMemo(() => execution ? buildActivity(job, execution.events) : [], [job, execution]);
  const latestRoute = execution?.metrics?.routes.at(-1);
  const live = job.status === "RUNNING" || job.status === "ESCALATING";
  useEffect(() => { if (live) consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight }); }, [consoleText, live]);

  return <div className="execution-panel execution-dashboard">
    <section className="execution-overview">
      <div><p className="panel-label">DEVELOPMENT STATUS</p><h3>{statusTitle(job.status, execution?.verification)}</h3><span>{execution?.completedAt ? `Finished ${new Date(execution.completedAt).toLocaleString()}` : execution ? `Started ${new Date(execution.startedAt).toLocaleString()}` : `Waiting for ${providerName}`}</span></div>
      {execution && <div className="execution-facts">
        <span><small>MODEL</small><b>{job.status === "ESCALATING" ? execution.model : latestRoute?.model ?? execution.model}</b></span>
        <span><small>REASONING</small><b>{reasoningLabel(job.status === "ESCALATING" ? execution.reasoning : latestRoute?.reasoning ?? execution.reasoning)}</b></span>
        <span title={job.jevUsage ? `${job.jevUsage.calls} JEV calls · ${formatNumber(job.jevUsage.inputTokens)} input tokens. Includes evaluation, continuity reviews and compaction hooks. Estimated from reported usage at $0.04 per million input tokens.` : "Complete JEV usage was not recorded for this ticket."}><small>JEV CREDITS</small><b>{job.jevUsage?.estimatedCostUsd !== undefined ? `≈ $${job.jevUsage.estimatedCostUsd.toFixed(6)}` : job.jevUsage?.missingCalls ? "Incomplete usage" : "Unavailable"}</b></span>
        <span><small>ACTUAL TOKENS</small><b>{formatNumber(execution.metrics?.actualTokens ?? execution.usage?.input_tokens)}</b></span>
      </div>}
    </section>
    {execution && <ExecutionStatusPanel status={execution.codexStatus} providerName={providerName}/>}
    <TicketIssue job={job}/>
    {!job.error && job.status !== "FAILED" && job.status !== "SESSION_PAUSED" && job.recoveryNote && <div className="verification-note"><b>Interrupted execution</b><span>{job.recoveryNote}</span></div>}
    {job.status !== "FAILED" && job.status !== "SESSION_PAUSED" && execution?.verificationNote && <div className="verification-note"><b>Verification note</b><span>{execution.verificationNote}</span></div>}
    {execution && <details className="execution-activity">
      <summary><div><p className="panel-label">JEV ACTIVITY</p><h4>Decisions and development log</h4></div><span>{activity.length} events</span><i aria-hidden="true">⌄</i></summary>
      <div className="activity-list">{activity.map(item => <article className={`activity-event ${item.tone}`} key={item.id}><i>{activityIcon(item.tone)}</i><div><div><b>{item.title}</b>{item.timestamp && <time>{new Date(item.timestamp).toLocaleTimeString()}</time>}</div>{item.detail && <p>{item.detail}</p>}</div></article>)}</div>
    </details>}
    <details className="raw-console" open={live}><summary>Raw {providerName} console {live ? "· streaming" : ""}</summary><div className="live-console"><pre ref={consoleRef}>{consoleText || `Waiting for the first ${providerName} event…`}{live && <span className="console-cursor">▋</span>}</pre></div></details>
    {job.output && <details className="raw-output"><summary>View raw {providerName} output</summary><pre>{job.output}</pre></details>}
  </div>;
}

function buildActivity(job: Job, events: ExecutionEvent[]): Activity[] {
  const result: Activity[] = [];
  if (job.analysis) {
    result.push({ id: "jev-recommendation", title: "JEV recommendation applied", detail: `${job.analysis.model} · ${reasoningLabel(job.analysis.reasoning)} reasoning`, tone: "jev" });
  }
  for (const event of events) if (isVisibleActivity(event)) result.push({ id: event.id, timestamp: event.timestamp, title: event.title, detail: compactDetail(event.detail), tone: activityTone(event) });
  if (job.error && !result.some(item => item.tone === "error")) result.push({ id: "execution-error", title: "Development stopped with an error", detail: job.error, tone: "error" });
  return result;
}

function isVisibleActivity(event: ExecutionEvent) { return !/^Starting | status checkpoint$/.test(event.title) && (event.kind === "command" || event.kind === "file" || event.kind === "error" || event.kind === "system"); }
function activityTone(event: ExecutionEvent): Activity["tone"] { if (event.kind === "error" || event.status === "error") return "error"; if (event.kind === "command") return "command"; if (/model changed|reasoning changed|routing|escalat|compact|clear/i.test(event.title)) return "route"; if (/completed|execution completed|verification satisfied/i.test(event.title)) return "complete"; return "jev"; }
function activityIcon(tone: Activity["tone"]) { return tone === "command" ? ">_" : tone === "route" ? "↗" : tone === "complete" ? "✓" : tone === "error" ? "!" : "J"; }
function compactDetail(detail?: string) { return detail?.length && detail.length > 1400 ? `${detail.slice(0, 1400)}…` : detail; }
function statusTitle(status: string, verification?: string) { if (status === "PENDING") return "Ready to resume"; if (status === "RUNNING") return "Development in progress"; if (status === "ESCALATING") return "Ticket escalation in progress"; if (status === "SESSION_PAUSED") return "Development paused"; if (status === "FAILED") return "Development needs attention"; return verification === "environment_blocked" ? "Development completed · checks partly blocked" : "Development completed"; }
