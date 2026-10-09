import { type ReactNode, useState } from "react";
import type { Job } from "../lib/types.js";
import { reasoningLabel } from "../lib/format.js";
import { useCodexModels } from "../hooks/use-codex-models.js";

const queueStatuses = ["PENDING", "RUNNING", "SUCCESS", "FAILED"] as const;

/** Renders a ticket status badge. */
export function Status({ status }: { status: string }) {
  const icon = status === "SUCCESS" ? "✓" : status === "FAILED" ? "!" : status === "SESSION_PAUSED" ? "Ⅱ" : status === "ESCALATING" ? "↗" : "";
  return <span className={`status status-${status.toLowerCase()}`}><i>{icon}</i>{status === "SUCCESS" ? "Done" : status === "PENDING" ? "To do" : status === "RUNNING" ? "Running" : status === "FAILED" ? "Failed" : status.replaceAll("_", " ")}</span>;
}

/** Renders the active queue and completed ticket history. */
export function QueueBoard({ jobs, selectedId, onSelect, onArchive, onEdit, onMove, onReorder, composer }: { composer?: ReactNode; jobs: Job[]; selectedId?: string; onSelect: (job: Job) => void; onArchive: (job: Job, action: "archive" | "unarchive") => Promise<void>; onEdit: (job: Job) => void; onReorder: (job: Job, beforeId: string | null) => Promise<void>; onMove: (job: Job, status: "PENDING" | "SUCCESS") => Promise<void> }) {
  const { models } = useCodexModels();
  const modelName = (tier: string) => models[tier] ?? tier;
  const visible = jobs.filter(job => !job.archivedAt && job.status !== "SKIPPED");
  const history = jobs.filter(job => job.archivedAt || job.status === "SKIPPED");
  const [draggedJobId, setDraggedJobId] = useState<string>();
  const [insertionId, setInsertionId] = useState<string | null>();
  const pending = visible.filter(job => job.status === "PENDING");
  const draggedJob = visible.find(job => job.id === draggedJobId);
  const clearDrag = () => { setDraggedJobId(undefined); setInsertionId(undefined); };
  const insertBefore = (event: React.DragEvent<HTMLDivElement>, job: Job) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? job.id : pending[pending.findIndex(item => item.id === job.id) + 1]?.id ?? null;
  };
  const moveTo = (status: string, jobId: string) => {
    const job = visible.find(candidate => candidate.id === jobId);
    clearDrag();
    const allowed = job && ((job.status === "FAILED" && (status === "PENDING" || status === "SUCCESS")) || (job.status === "SUCCESS" && status === "PENDING"));
    if (allowed) void onMove(job, status as "PENDING" | "SUCCESS");
  };
  const historyLabel = (job: Job) => job.status === "SKIPPED" ? "SKIPPED" : `COMPLETED — ${job.analysis ? `${modelName(job.analysis.model)} · ${reasoningLabel(job.analysis.reasoning)}` : "Codex model unavailable"}`;

  const columnStatus = (job: Job) => job.status === "ESCALATING" ? "RUNNING" : job.status === "SESSION_PAUSED" ? "FAILED" : job.status;
  const escalated = (job: Job) => job.status === "ESCALATING" || job.execution?.escalationPending || job.analysis?.rationale.some(reason => reason.startsWith("Automatic escalation after "));

  return <section className="queue-board">
    <div className="queue-columns">
      {queueStatuses.map(status => {
        const canDrop = Boolean(draggedJob && ((status === "PENDING" && (draggedJob.status === "FAILED" || draggedJob.status === "SUCCESS" || draggedJob.status === "PENDING")) || (status === "SUCCESS" && draggedJob.status === "FAILED")));
        return <div className={`queue-column ${draggedJobId && canDrop ? "drop-target" : ""}`} key={status} onDragOver={event => { if (canDrop) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; if (status === "PENDING" && draggedJob?.status === "PENDING") setInsertionId(null); } }} onDrop={event => { event.preventDefault(); const jobId = event.dataTransfer.getData("text/plain") || draggedJobId || ""; const job = visible.find(item => item.id === jobId); if (status === "PENDING" && job?.status === "PENDING") { clearDrag(); void onReorder(job, null); } else moveTo(status, jobId); }}>
          <header><Status status={status}/><b>{visible.filter(job => columnStatus(job) === status).length}</b></header>
          {visible.filter(job => columnStatus(job) === status).map(job => <div key={job.id} className={`queue-card-wrap ${status === "PENDING" && insertionId === job.id ? "insert-before" : ""}`} draggable={job.status === "PENDING" || job.status === "FAILED" || job.status === "SUCCESS"} onDragStart={event => { event.dataTransfer.setData("text/plain", job.id); event.dataTransfer.effectAllowed = "move"; setDraggedJobId(job.id); }} onDragEnd={clearDrag} onDragOver={event => { if (status === "PENDING" && draggedJob?.status === "PENDING") { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setInsertionId(insertBefore(event, job)); } }} onDrop={event => { if (status === "PENDING") { const source = visible.find(item => item.id === (event.dataTransfer.getData("text/plain") || draggedJobId)); if (source?.status === "PENDING") { event.preventDefault(); event.stopPropagation(); const beforeId = insertBefore(event, job); clearDrag(); if (beforeId !== source.id) void onReorder(source, beforeId); } } }}>
            <button className={`queue-card ${job.id === selectedId ? "active" : ""} ${escalated(job) ? "ticket-escalated" : ""} ${job.status === "SESSION_PAUSED" ? "ticket-paused" : ""}`} onClick={() => onSelect(job)}>
              <small>{escalated(job) ? "↗ ESCALATED · " : ""}{job.status === "SESSION_PAUSED" ? "Ⅱ SESSION PAUSED · " : ""}TASK {status === "PENDING" ? pending.findIndex(item => item.id === job.id) + 1 : (job.order ?? 0) + 1}</small>
              <b>{job.tasks[0]?.description}</b>
              <span>{job.status === "SESSION_PAUSED" ? `Waiting for Codex session${job.sessionResumeAt ? ` · resumes after ${new Date(job.sessionResumeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}` : job.status === "ESCALATING" ? `Escalating to ${job.analysis ? `${modelName(job.analysis.model)} · ${reasoningLabel(job.analysis.reasoning)}` : "next route"}` : job.analysis ? `${modelName(job.analysis.model)} · ${reasoningLabel(job.analysis.reasoning)}` : "Waiting for JEV"}{job.attachments?.length ? ` · ${job.attachments.length} image${job.attachments.length === 1 ? "" : "s"}` : ""}</span>
              {Boolean(job.skills?.length) && <div className="ticket-skill-labels">{job.skills?.map(skill => <span key={skill.id} title={skill.description}>◇ {skill.name}</span>)}</div>}
              {job.recoveryNote && <em className="queue-verification-note">{job.recoveryNote}</em>}
              {job.error && <em className="queue-verification-note">{job.errorCategory ?? "error"}: {job.error}</em>}
              {job.gitDelivery?.status === "failed" && <em className="queue-verification-note">Git delivery failed: {job.gitDelivery.error}</em>}
              {(job.gitDelivery?.status === "committed" || job.gitDelivery?.status === "pushed") && <em className="queue-verification-note">Committed {job.gitDelivery.commit} on {job.gitDelivery.branch}{job.gitDelivery.message ? ` · ${job.gitDelivery.message}` : ""}</em>}
              {job.execution?.verificationNote && <em className="queue-verification-note">{job.execution.verificationNote}</em>}
            </button>
            {status === "PENDING" && <button className="edit-task" title="Edit and re-evaluate this pending task" aria-label={`Edit ${job.tasks[0]?.description ?? "task"}`} onClick={() => onEdit(job)}>✎</button>}
            {status === "SUCCESS" && <button className="archive-task" title="Archive this completed task" aria-label={`Archive ${job.tasks[0]?.description ?? "task"}`} onClick={() => void onArchive(job, "archive")}>✓</button>}
            {job.status === "FAILED" && <button className="failed-success" title="Move this failed task to Success" aria-label={`Validate ${job.tasks[0]?.description ?? "task"}`} onClick={() => void onMove(job, "SUCCESS")}>✓ Validate</button>}
          </div>)}
          {status === "PENDING" && composer}
          {status === "PENDING" && insertionId === null && draggedJob?.status === "PENDING" && <div className="queue-insertion-end"/>}
        </div>;
      })}
    </div>
    {history.length > 0 && <details className="task-history"><summary>Completed and skipped history <b>{history.length}</b></summary><div>{history.map(job => <article key={job.id}><button type="button" onClick={() => onSelect(job)}><small>{historyLabel(job)}</small><b>{job.tasks[0]?.description}</b></button>{job.archivedAt && <button className="restore-task" type="button" onClick={() => void onArchive(job, "unarchive")}>↶ Undo</button>}</article>)}</div></details>}
  </section>;
}
