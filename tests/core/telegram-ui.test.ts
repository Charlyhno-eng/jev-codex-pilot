import { describe, expect, it } from "vitest";
import { composeTicketScreen, createdTicketScreen, homeScreen, projectScreen, runProjectScreen } from "../../src/core/telegram-ui.js";
import type { Job, ProjectRecord } from "../../src/core/types.js";

const project: ProjectRecord = { id: "p1", name: "A < B & C", path: "/project", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const job = (status: Job["status"], description = "Fix <input> & output", extra: Partial<Job> = {}): Job => ({
  id: status, projectId: project.id, projectPath: project.path, tasks: [{ description }], status,
  createdAt: "2026-01-01", updatedAt: "2026-01-01", attempts: 0, ...extra
});

describe("Telegram screens", () => {
  it("counts only active tickets and offers launch only for pending work", () => {
    const jobs = [job("PENDING"), job("RUNNING"), job("SUCCESS", "old", { archivedAt: "2026-01-02" }), job("SKIPPED")];
    const home = homeScreen([project], () => jobs);
    expect(home.text).toContain("<b>1</b> pending");
    expect(home.text).toContain("<b>1</b> active");
    expect(projectScreen(project, jobs).buttons.flat().some(button => button.action === "run")).toBe(true);
    expect(runProjectScreen([project], () => jobs.filter(item => item.status === "PENDING")).buttons[0][0].argument).toBe(project.id);
    expect(runProjectScreen([project], () => []).text).toContain("QUEUE CLEAR");
  });

  it("escapes project names, ticket text, and composition warnings", () => {
    expect(composeTicketScreen(project, "Avoid <tags> & markup").text).toContain("Avoid &lt;tags&gt; &amp; markup");
    expect(createdTicketScreen(project, job("PENDING")).text).toContain("Fix &lt;input&gt; &amp; output");
    expect(projectScreen(project, [job("RUNNING")]).text).toContain("A &LT; B &AMP; C");
    expect(projectScreen(project, [job("RUNNING")]).text).toContain("Fix &lt;input&gt; &amp; output");
  });
});
