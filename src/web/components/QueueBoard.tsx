import { useState } from "react";
import type { Job } from "../lib/types.js";
import { reasoningLabel } from "../lib/format.js";
import { useCodexModels } from "../hooks/use-codex-models.js";

const queueStatuses = ["PENDING", "RUNNING", "ESCALATING", "SUCCESS", "SESSION_PAUSED", "FAILED"] as const;

/** Renders a ticket status badge. */
export function Status({ status }: { status: string }) {
  const icon = status === "SUCCESS" ? "✓" : status === "FAILED" ? "!" : status === "SESSION_PAUSED" ? "Ⅱ" : status === "ESCALATING" ? "↗" : "";
  return <span className={`status status-${status.toLowerCase()}`}><i>{icon}</i>{status === "SUCCESS" ? "DONE" : status.replaceAll("_", " ")}</span>;
}

/** Renders the active queue and completed ticket history. */
export function QueueBoard({ jobs, selectedId, onSelect, onArchive, onEdit, onMove }: { jobs: Job[]; selectedId?: string; onSelect: (job: Job) => void; onArchive: (job: Job, action: "archive" | "unarchive") => Promise<void>; onEdit: (job: Job) => void; onMove: (job: Job, status: "PENDING" | "SUCCESS") => Promise<void> }) {
  const { models } = useCodexModels();
  const modelName = (tier: string) => models[tier] ?? tier;
  const visible = jobs.filter(job => !job.archivedAt && job.status !== "SKIPPED");
  const history = jobs.filter(job => job.archivedAt || job.status === "SKIPPED");
  const [draggedJobId, setDraggedJobId] = useState<string>();
  const moveTo = (status: string) => {
    const job = visible.find(candidate => candidate.id === draggedJobId);
    setDraggedJobId(undefined);
    const allowed = job && ((job.status === "FAILED" && (status === "PENDING" || status === "SUCCESS")) || (job.status === "SUCCESS" && status === "PENDING"));
    if (allowed) void onMove(job, status as "PENDING" | "SUCCESS");
  };
  const historyLabel = (job: Job) => job.status === "SKIPPED" ? "SKIPPED" : `COMPLETED — ${job.analysis ? `${modelName(job.analysis.model)} · ${reasoningLabel(job.analysis.reasoning)}` : "Codex model unavailable"}`;

  return <section className="queue-board">
    <div className="section-heading"><span className="step">02</span><div><h2>Task queue</h2><p>Failed attempts automatically escalate through stronger routes before entering Failed.</p></div></div>
    <div className="queue-columns">
      {queueStatuses.map(status => {
        const canDrop = status !== "RUNNING" && status !== "ESCALATING" && status !== "SESSION_PAUSED";
        return <div className={`queue-column ${draggedJobId && canDrop ? "drop-target" : ""}`} key={status} onDragOver={event => { if (draggedJobId && canDrop) event.preventDefault(); }} onDrop={() => moveTo(status)}>
          <header><Status status={status}/><b>{visible.filter(job => job.status === status).length}</b></header>
          {visible.filter(job => job.status === status).map(job => <div key={job.id} className="queue-card-wrap">
            <button className={job.id === selectedId ? "queue-card active" : "queue-card"} draggable={job.status === "FAILED" || job.status === "SUCCESS"} onDragStart={() => (job.status === "FAILED" || job.status === "SUCCESS") && setDraggedJobId(job.id)} onDragEnd={() => setDraggedJobId(undefined)} onClick={() => onSelect(job)}>
              <small>TASK {(job.order ?? 0) + 1}</small>
              <b>{job.tasks[0]?.description}</b>
              <span>{job.status === "SESSION_PAUSED" ? `Waiting for Codex session${job.sessionResumeAt ? ` · resumes after ${new Date(job.sessionResumeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}` : job.status === "ESCALATING" ? `Escalating to ${job.analysis ? `${modelName(job.analysis.model)} · ${reasoningLabel(job.analysis.reasoning)}` : "next route"}` : job.analysis ? `${modelName(job.analysis.model)} · ${reasoningLabel(job.analysis.reasoning)}` : "Waiting for JEV"}{job.attachments?.length ? ` · ${job.attachments.length} image${job.attachments.length === 1 ? "" : "s"}` : ""}</span>
              {job.recoveryNote && <em className="queue-verification-note">{job.recoveryNote}</em>}
              {job.error && <em className="queue-verification-note">{job.errorCategory ?? "error"}: {job.error}</em>}
              {job.execution?.verificationNote && <em className="queue-verification-note">{job.execution.verificationNote}</em>}
              {job.notificationError && <em className="queue-verification-note">Telegram notification failed: {job.notificationError}</em>}
            </button>
            {status === "PENDING" && <button className="edit-task" title="Edit and re-evaluate this pending task" aria-label={`Edit ${job.tasks[0]?.description ?? "task"}`} onClick={() => onEdit(job)}>✎</button>}
            {status === "SUCCESS" && <button className="archive-task" title="Archive this completed task" aria-label={`Archive ${job.tasks[0]?.description ?? "task"}`} onClick={() => void onArchive(job, "archive")}>✓</button>}
            {status === "FAILED" && <button className="failed-success" title="Move this failed task to Success" aria-label={`Validate ${job.tasks[0]?.description ?? "task"}`} onClick={() => void onMove(job, "SUCCESS")}>✓ Validate</button>}
          </div>)}
        </div>;
      })}
    </div>
    {history.length > 0 && <details className="task-history"><summary>Completed and skipped history <b>{history.length}</b></summary><div>{history.map(job => <article key={job.id}><button type="button" onClick={() => onSelect(job)}><small>{historyLabel(job)}</small><b>{job.tasks[0]?.description}</b></button>{job.archivedAt && <button className="restore-task" type="button" onClick={() => void onArchive(job, "unarchive")}>↶ Undo</button>}</article>)}</div></details>}
  </section>;
}
