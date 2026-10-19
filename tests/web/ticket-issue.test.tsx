import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TicketIssue } from "../../src/web/components/TicketIssue.js";
import { ExecutionPanel } from "../../src/web/components/ExecutionPanel.js";
import type { Job } from "../../src/web/lib/types.js";

function ticket(patch: Partial<Job> = {}): Job {
  return { id: "failed-ticket", projectId: "project", projectPath: "/project", tasks: [{ description: "Fix button" }], status: "FAILED", createdAt: "2026-10-19T12:00:00Z", ...patch };
}
function render(job: Job) {
  return renderToStaticMarkup(<MemoryRouter><TicketIssue job={job} consoleLink/></MemoryRouter>);
}

describe("selected ticket problem details", () => {
  it.each([
    ["jev", "JEV · ticket preparation or analysis"],
    ["dependency", "Project dependencies"],
    ["verification", "Project verification"],
    ["code", "Codex · implementation"],
    ["agent", "Codex / execution workflow"],
    ["interruption", "JEV server / process interruption"],
  ] as const)("identifies %s errors and preserves their exact reason", (errorCategory, origin) => {
    const markup = render(ticket({ errorCategory, error: "Detailed failure\nwith its original context" }));
    expect(markup).toContain(origin);
    expect(markup).toContain("Detailed failure\nwith its original context");
    expect(markup).toContain('href="/projects/project/console/failed-ticket"');
  });

  it("shows the provider's final explanation, rather than only a generic blocked message", () => {
    const job = ticket({ errorCategory: "code", error: "Implementation blocked", execution: {
      providerId: "other", providerName: "Other AI", phase: "ERROR", model: "model", reasoning: "medium",
      startedAt: "2026-10-19T12:00:00Z", lastActivityAt: "2026-10-19T12:00:01Z", verification: "not_run",
      events: [
        { id: "old", timestamp: "", kind: "message", title: "Update", detail: "Reading files" },
        { id: "final", timestamp: "", kind: "message", title: "Update", detail: "Cannot edit src/button.ts because the filesystem is read-only." },
        { id: "error", timestamp: "", kind: "error", title: "Execution failed", detail: "Implementation blocked" },
      ],
    } });
    const markup = render(job);
    expect(markup).toContain("Other AI · implementation");
    expect(markup).toContain("Last Other AI response");
    expect(markup).toContain("Cannot edit src/button.ts because the filesystem is read-only.");
    expect(markup).not.toContain("Reading files");
    expect(renderToStaticMarkup(<ExecutionPanel job={job}/>)).toContain("Cannot edit src/button.ts");
  });

  it("acknowledges missing historical causes without inventing one", () => {
    const markup = render(ticket());
    expect(markup).toContain("Origin not recorded");
    expect(markup).toContain("No precise cause was recorded");
  });

  it("distinguishes a quota pause in Failed from a development failure", () => {
    const markup = render(ticket({ status: "SESSION_PAUSED", errorCategory: "quota", error: "Usage limit reached" }));
    expect(markup).toContain("Development paused");
    expect(markup).toContain("Automatic resume when");
    expect(markup).toContain("ticket-issue-paused");
    expect(markup).not.toContain("Why this ticket failed");
  });

  it("keeps Git delivery failures separate from successful development", () => {
    const markup = render(ticket({ status: "SUCCESS", gitDelivery: { status: "failed", error: "Git author identity missing" } }));
    expect(markup).toContain("Automatic Git commit failed");
    expect(markup).toContain("Git author identity missing");
    expect(markup).not.toContain("Why this ticket failed");
  });

  it("renders saved messages as text and hides diagnostics after a successful retry", () => {
    const markup = render(ticket({ error: '<script>alert("x")</script>' }));
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
    expect(render(ticket({ status: "SUCCESS" }))).toBe("");
    expect(render(ticket({ status: "RUNNING" }))).toBe("");
  });
});
