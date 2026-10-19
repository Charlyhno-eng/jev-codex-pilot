import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ExecutionEvent, Job } from "../lib/types.js";

type Issue = { source: string; explanation: string };

/** Explains a ticket's recorded failure or pause, with optional selected-ticket evidence. */
export function TicketIssue({ job, loadDetails = false, consoleLink = false }: { job: Job; loadDetails?: boolean; consoleLink?: boolean }) {
  const provider = job.execution?.providerName ?? "Codex";
  const paused = job.status === "SESSION_PAUSED";
  const failed = job.status === "FAILED";
  const gitFailed = job.gitDelivery?.status === "failed";
  const hasExecution = Boolean(job.execution);
  const key = JSON.stringify([job.id, job.status, job.error, job.execution?.completedAt]);
  const [details, setDetails] = useState<{ key: string; events: ExecutionEvent[] }>();
  const [unavailable, setUnavailable] = useState<string>();
  // Only the selected failed ticket needs its full log; the board keeps lightweight polling.
  useEffect(() => {
    if (!loadDetails || !failed || !hasExecution) return;
    const controller = new AbortController();
    void fetch(`/api/jobs/${encodeURIComponent(job.id)}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Ticket details unavailable");
        const full = await response.json() as Job;
        if (!controller.signal.aborted) setDetails({ key, events: full.execution?.events ?? [] });
      }).catch(() => { if (!controller.signal.aborted) setUnavailable(key); });
    return () => controller.abort();
  }, [loadDetails, failed, job.id, hasExecution, key]);

  if (!failed && !paused && !job.error && !gitFailed) return null;
  const issue = issueOrigin(job.errorCategory, provider);
  const events = details?.key === key ? details.events : job.execution?.events ?? [];
  const lastResponse = failed ? [...events].reverse().find(event => event.kind === "message" && event.detail) : undefined;
  const lastError = failed ? [...events].reverse().find(event => event.kind === "error" && event.detail) : undefined;
  const cause = job.error || (paused ? `${provider} reported a session usage limit.` : lastError?.detail) || "No precise cause was recorded for this ticket. Open the console to inspect the available execution history.";

  return <section className={`ticket-issue ${paused ? "ticket-issue-paused" : ""}`} aria-label="Ticket problem details">
    {(failed || paused || job.error) && <>
      <h3>{paused ? "Development paused" : failed ? "Why this ticket failed" : "Recorded ticket issue"}</h3>
      <dl><div><dt>Origin</dt><dd>{paused ? `${provider} session quota` : issue.source}</dd></div>
        <div><dt>What happened</dt><dd>{paused ? "The session usage limit was reached. This ticket is waiting to resume." : issue.explanation}</dd></div>
        <div><dt>Recorded reason</dt><dd className="ticket-issue-detail">{cause}</dd></div>
      </dl>
      {lastError && job.error && lastError.detail !== job.error && <div><b>Recorded error detail</b><pre>{lastError.detail}</pre></div>}
      {lastResponse && <div><b>Last {provider} response</b><pre>{lastResponse.detail}</pre></div>}
      {job.execution?.verificationNote && <div><b>Verification context</b><pre>{job.execution.verificationNote}</pre></div>}
      {job.recoveryNote && <div><b>Recovery context</b><pre>{job.recoveryNote}</pre></div>}
      {paused && <p>{job.sessionResumeAt ? `Automatic resume after ${new Date(job.sessionResumeAt).toLocaleString()}.` : `Automatic resume when the next ${provider} session is available.`}</p>}
    </>}
    {gitFailed && <div><h3>Automatic Git commit failed</h3><p>Origin: Git delivery. The ticket's development status is shown separately.</p><pre>{job.gitDelivery?.error || "Git did not record a precise cause."}</pre></div>}
    {unavailable === key && <p>Additional details could not be loaded. The saved reason remains available above; open the console to retry loading the history.</p>}
    {consoleLink && <Link to={`/projects/${job.projectId}/console/${job.id}`}>Open ticket console and full history →</Link>}
  </section>;
}

function issueOrigin(category: Job["errorCategory"], provider: string): Issue {
  const origins: Record<NonNullable<Job["errorCategory"]>, Issue> = {
    code: { source: `${provider} · implementation`, explanation: "The ticket was stopped because implementation was reported as blocked or unsuccessful." },
    verification: { source: "Project verification", explanation: "The required verification could not be completed." },
    dependency: { source: "Project dependencies", explanation: "A dependency required to continue or verify the work is missing." },
    codex: { source: `${provider} / execution workflow`, explanation: "An error was recorded while starting, executing, or finalizing this ticket." },
    agent: { source: `${provider} / execution workflow`, explanation: "An error was recorded while starting, executing, or finalizing this ticket." },
    loop: { source: "JEV · repetition protection", explanation: "An earlier execution was stopped after repeated activity without project changes." },
    quota: { source: `${provider} session quota`, explanation: "The coding provider reported a usage limit." },
    interruption: { source: "JEV server / process interruption", explanation: "The execution was interrupted before it could finish." },
    jev: { source: "JEV · ticket preparation or analysis", explanation: "JEV encountered a problem while preparing or evaluating this ticket." },
  };
  return category ? origins[category] : { source: "Origin not recorded", explanation: "The ticket has an error, but its origin was not classified." };
}
