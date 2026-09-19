import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobQueue } from "./queue.js";

describe("task archive", () => {
  it("hides a successful task reversibly without changing its execution result", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-queue-"));
    const project = join(root, "project");
    mkdirSync(project);
    const queue = new JobQueue(join(root, "data"));
    const job = queue.create("project", project, [{ description: "Completed work" }]);
    queue.transition(job.id, "SUCCESS");

    const archived = queue.archive(job.id)!;
    expect(archived.status).toBe("SUCCESS");
    expect(archived.archivedAt).toBeTruthy();
    expect(queue.unarchive(job.id)?.archivedAt).toBeUndefined();
  });

  it("lets a user move only a failed task back to pending or success", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-move-"));
    const project = join(root, "project");
    mkdirSync(project);
    const queue = new JobQueue(join(root, "data"));
    const job = queue.create("project", project, [{ description: "Repair the game movement" }]);
    queue.transition(job.id, "FAILED", { error: "A duplicate launch was reported" });

    const restored = queue.moveFailed(job.id, "PENDING")!;
    expect(restored.status).toBe("PENDING");
    expect(restored.error).toBeUndefined();
    queue.transition(job.id, "FAILED");
    expect(queue.moveFailed(job.id, "SUCCESS")?.status).toBe("SUCCESS");
    expect(() => queue.moveFailed(job.id, "PENDING")).toThrow("Only failed tasks");
  });
});

describe("pending recommendation tuning", () => {
  it("moves model and reasoning one level while the task is pending", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-tuning-"));
    const project = join(root, "project");
    mkdirSync(project);
    const queue = new JobQueue(join(root, "data"));
    const job = queue.create("project", project, [{ description: "Move two buttons" }]);
    queue.update(job.id, { analysis: { complexity: "low", complexity_score: 2, task_types: ["ui_ux"], model: "luna", reasoning: "low", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" } });

    expect(queue.adjustAnalysis(job.id, "model", 1)?.analysis?.model).toBe("terra");
    expect(queue.adjustAnalysis(job.id, "reasoning", 1)?.analysis?.reasoning).toBe("medium");
    expect(queue.adjustAnalysis(job.id, "model", -1)?.analysis?.model).toBe("luna");
  });
});
