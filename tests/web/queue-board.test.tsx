import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueueBoard } from "../../src/web/components/QueueBoard.js";
import type { Job, JobStatus } from "../../src/web/lib/types.js";

function ticket(status: JobStatus): Job {
  return { id: status, projectId: "project", projectPath: "/project", tasks: [{ description: `${status} ticket` }], status, createdAt: "2026-10-09T12:00:00Z" };
}

function board(jobs: Job[]) {
  return renderToStaticMarkup(<QueueBoard jobs={jobs} composer={<form aria-label="New ticket"><input type="file"/></form>} onSelect={() => {}} onArchive={async () => {}} onEdit={() => {}} onMove={async () => {}} onReorder={async () => {}}/>);
}

describe("four-column task workspace", () => {
  it("groups all six execution statuses into four columns and creates only in To do", () => {
    const markup = board(["PENDING", "RUNNING", "SUCCESS", "ESCALATING", "SESSION_PAUSED", "FAILED"].map(status => ticket(status as JobStatus)));
    const columns = markup.split('<div class="queue-column ' ).slice(1);
    expect(columns).toHaveLength(4);
    expect(columns[0]).toContain("To do");
    expect(columns[0]).toContain('aria-label="New ticket"');
    expect(columns[1]).toContain("RUNNING ticket");
    expect(columns[1]).toContain("ESCALATING ticket");
    expect(columns[2]).toContain("SUCCESS ticket");
    expect(columns[3]).toContain("SESSION_PAUSED ticket");
    expect(columns[3]).toContain("FAILED ticket");
    expect(columns.slice(1).join("")).not.toContain('aria-label="New ticket"');
  });

  it("marks paused sessions without allowing failed-ticket validation or dragging", () => {
    const markup = board([ticket("SESSION_PAUSED")]);
    expect(markup).toContain("ticket-paused");
    expect(markup).toContain("SESSION PAUSED");
    expect(markup).toContain('draggable="false"');
    expect(markup).not.toContain("failed-success");
  });

  it("retains the escalation marker when a ticket completes and its event log is omitted", () => {
    const job = ticket("SUCCESS");
    job.analysis = { complexity: 4, model: "sol", reasoning: "high", task_types: [], rationale: ["Automatic escalation after gpt-6-luna high failed; next route is gpt-6.1-sol low."] };
    const markup = board([job]);
    expect(markup).toContain("ticket-escalated");
    expect(markup).toContain("ESCALATED");
    expect(markup).toContain("SUCCESS ticket");
  });
  it("shows the skills attached to a saved ticket without adding library-wide skills", () => {
    const selected = ticket("PENDING");
    selected.skills = [{ id: "web-design", name: "web-interface-design", description: "Refine web interfaces" }];
    const markup = board([selected, ticket("RUNNING")]);
    expect(markup).toContain('title="Refine web interfaces"');
    expect(markup.split("web-interface-design")).toHaveLength(2);
    expect(markup).not.toContain("python-performance-simplification");
  });

});
