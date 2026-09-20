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

    const restored = queue.moveManually(job.id, "PENDING")!;
    expect(restored.status).toBe("PENDING");
    expect(restored.error).toBeUndefined();
    queue.transition(job.id, "FAILED");
    expect(queue.moveManually(job.id, "SUCCESS")?.status).toBe("SUCCESS");
    expect(queue.moveManually(job.id, "PENDING")?.status).toBe("PENDING");
    expect(() => queue.moveManually(job.id, "SUCCESS")).toThrow("Only failed tasks");
  });

  it("returns a successful task to pending when a user wants it redone", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-success-move-"));
    const project = join(root, "project");
    mkdirSync(project);
    const queue = new JobQueue(join(root, "data"));
    const job = queue.create("project", project, [{ description: "Completed work that needs revision" }]);
    queue.transition(job.id, "SUCCESS");

    const restored = queue.moveManually(job.id, "PENDING")!;
    expect(restored.status).toBe("PENDING");
  });
});

describe("pending recommendation tuning", () => {
  it("permanently removes a pending task without allowing completed history to be removed", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-remove-"));
    const project = join(root, "project");
    mkdirSync(project);
    const queue = new JobQueue(join(root, "data"));
    const pending = queue.create("project", project, [{ description: "Discard this draft" }]);
    const completed = queue.create("project", project, [{ description: "Keep this completed task" }]);
    queue.transition(completed.id, "SUCCESS");

    expect(queue.removePending(pending.id)?.id).toBe(pending.id);
    expect(queue.get(pending.id)).toBeUndefined();
    expect(() => queue.removePending(completed.id)).toThrow("Only pending tasks");
  });

  it("edits a pending task and invalidates its old JEV recommendation", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-edit-"));
    const project = join(root, "project");
    mkdirSync(project);
    const queue = new JobQueue(join(root, "data"));
    const job = queue.create("project", project, [{ description: "Move one button" }]);
    queue.update(job.id, { analysis: { complexity: "low", complexity_score: 2, task_types: ["ui_ux"], model: "luna", reasoning: "low", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" } });

    const edited = queue.updatePendingTask(job.id, "Move both navigation buttons")!;
    expect(edited.tasks[0].description).toBe("Move both navigation buttons");
    expect(edited.analysis).toBeUndefined();
  });

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

describe("automatic retry scheduling", () => {
  it("returns only a failed task to pending and records why", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-retry-"));
    const project = join(root, "project");
    mkdirSync(project);
    const queue = new JobQueue(join(root, "data"));
    const job = queue.create("project", project, [{ description: "Repair the button" }]);
    queue.transition(job.id, "FAILED", { error: "Temporary failure" });

    const retried = queue.scheduleAutomaticRetry(job.id, "Update the layout")!;
    expect(retried.status).toBe("PENDING");
    expect(retried.error).toBeUndefined();
    expect(retried.execution).toBeUndefined();
    expect(() => queue.scheduleAutomaticRetry(job.id, "Update the layout")).toThrow("Only failed tasks");
  });
});
