import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobQueue } from "../../src/core/queue.js";

describe("task archive", () => {
  it("migrates saved text complexity and removes the retired delivery score", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-complexity-migration-"));
    const data = join(root, "data");
    const queue = new JobQueue(data);
    const job = queue.create("project", root, [{ description: "Existing ticket" }]);
    const file = join(data, "jobs.json");
    const jobs = JSON.parse(readFileSync(file, "utf8"));
    jobs[0].analysis = { complexity: "high", independent_delivery_score: 80, task_types: ["feature"], model: "astra", reasoning: "high", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    writeFileSync(file, JSON.stringify(jobs));
    const restored = new JobQueue(data).get(job.id)?.analysis;
    expect(restored?.complexity).toBe(4);
    expect(restored).toMatchObject({ model: "sol", reasoning: "medium" });
    expect(restored).not.toHaveProperty("independent_delivery_score");
  });

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
    queue.update(job.id, { analysis: { complexity: 1, task_types: ["ui_ux"], model: "luna", reasoning: "low", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" } });

    const edited = queue.updatePendingTask(job.id, "Move both navigation buttons")!;
    expect(edited.tasks[0].description).toBe("Move both navigation buttons");
    expect(edited.analysis).toBeUndefined();
  });

  it("lets users adjust pending recommendations across configured levels", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-tuning-"));
    const project = join(root, "project");
    mkdirSync(project);
    const queue = new JobQueue(join(root, "data"));
    const job = queue.create("project", project, [{ description: "Move two buttons" }]);
    queue.update(job.id, { analysis: { complexity: 2, task_types: ["ui_ux"], model: "luna", reasoning: "high", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" } });

    expect(queue.adjustAnalysis(job.id, "model", 1)?.analysis).toMatchObject({ model: "sol", reasoning: "high" });
    expect(queue.adjustAnalysis(job.id, "reasoning", -1)?.analysis?.reasoning).toBe("medium");
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

describe("interrupted execution recovery", () => {
  it("preserves an interrupted escalation route and thread across recovery and reload", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-recover-escalation-"));
    const queue = new JobQueue(root);
    const job = queue.create("project", root, [{ description: "Finish partial work" }]);
    const now = new Date().toISOString();
    queue.transition(job.id, "ESCALATING", {
      analysis: { complexity: 1, task_types: ["feature"], model: "sol", reasoning: "high", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" },
      attempts: 4, output: "Partial work",
      execution: { phase: "QUEUED", model: "gpt-6.1-sol", reasoning: "high", startedAt: now, lastActivityAt: now, threadId: "partial-thread", verification: "not_run", events: [] }
    });
    expect(queue.recoverInterrupted(() => false, () => true)).toEqual([]);
    expect(queue.recoverInterrupted(() => false)).toHaveLength(1);
    const restored = new JobQueue(root);
    expect(restored.get(job.id)).toMatchObject({ status: "PENDING", attempts: 4, output: "Partial work", analysis: { model: "sol", reasoning: "high" }, execution: { phase: "QUEUED", threadId: "partial-thread", escalationPending: true } });
    expect(restored.get(job.id)?.recoveryNote).toContain("ready to run again");
    expect(restored.recoverInterrupted(() => false)).toEqual([]);
  });

  it("waits for a live Codex process and preserves the ticket until it exits", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-recover-"));
    const project = join(root, "project");
    mkdirSync(project);
    const data = join(root, "data");
    const queue = new JobQueue(data);
    const job = queue.create("project", project, [{ description: "Keep the work" }]);
    const now = new Date().toISOString();
    queue.transition(job.id, "RUNNING", { execution: { phase: "WORKING", model: "gpt-5.6-terra", reasoning: "medium", startedAt: now, lastActivityAt: now, pid: 12345, verification: "not_run", events: [] } });

    const restarted = new JobQueue(data);
    expect(restarted.get(job.id)?.status).toBe("RUNNING");
    expect(restarted.recoverInterrupted(pid => pid === 12345)).toEqual([]);
    expect(restarted.get(job.id)?.status).toBe("RUNNING");
    expect(restarted.recoverInterrupted(() => false)).toHaveLength(1);
    expect(restarted.get(job.id)).toMatchObject({ status: "PENDING", errorCategory: "interruption", execution: { phase: "QUEUED" } });
    expect(restarted.get(job.id)?.execution?.events.at(-1)?.title).toBe("Execution interrupted");
  });
});


describe("pending execution order", () => {
  it("persists moves across batches, leaves completed work in place, and appends new tickets", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-reorder-"));
    const queue = new JobQueue(root);
    const [first, done, second] = queue.createBatch("project", root, [
      { description: "First" }, { description: "Completed" }, { description: "Second" }
    ]);
    queue.transition(done.id, "SUCCESS");
    const last = queue.create("project", root, [{ description: "Later batch" }]);
    queue.update(last.id, { createdAt: "2099-01-01T00:00:00.000Z" });
    const other = queue.create("other", root, [{ description: "Other project" }]);
    queue.reorderPending(last.id, first.id);
    expect(queue.listProjectExecutionOrder("project").map(job => job.id)).toEqual([last.id, done.id, first.id, second.id]);
    queue.reorderPending(last.id, null);
    expect(queue.listProjectExecutionOrder("project").map(job => job.id)).toEqual([first.id, done.id, second.id, last.id]);
    queue.reorderPending(second.id, first.id);
    const restored = new JobQueue(root);
    const added = restored.create("project", root, [{ description: "New arrival" }]);
    expect(restored.listProjectExecutionOrder("project").map(job => job.id)).toEqual([second.id, done.id, first.id, last.id, added.id]);
    expect(restored.get(done.id)?.status).toBe("SUCCESS");
    expect(restored.get(second.id)).toMatchObject({ order: second.order, batchId: second.batchId, status: "PENDING", attempts: 0 });
    expect(restored.get(other.id)).toEqual(other);
  });

  it("rejects non-pending and foreign destinations without changing order", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-reorder-invalid-"));
    const queue = new JobQueue(root);
    const [pending, running] = queue.createBatch("project", root, [{ description: "Pending" }, { description: "Running" }]);
    queue.transition(running.id, "RUNNING");
    const foreign = queue.create("other", root, [{ description: "Other" }]);
    const before = queue.listProjectExecutionOrder("project");
    expect(() => queue.reorderPending(running.id, pending.id)).toThrow("Only visible pending");
    expect(() => queue.reorderPending(pending.id, running.id)).toThrow("destination");
    expect(() => queue.reorderPending(pending.id, foreign.id)).toThrow("same project");
    expect(() => queue.reorderPending(pending.id, "missing")).toThrow("destination");
    expect(queue.reorderPending(pending.id, pending.id)).toEqual(pending);
    expect(queue.listProjectExecutionOrder("project")).toEqual(before);
  });

  it("keeps legacy tickets in submitted order until manually reordered", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-reorder-legacy-"));
    const queue = new JobQueue(root);
    const jobs = queue.createBatch("project", root, [{ description: "First" }, { description: "Second" }]);
    for (const job of jobs) queue.update(job.id, { queuePosition: undefined });
    const restored = new JobQueue(root);
    expect(restored.listProjectExecutionOrder("project").map(job => job.id)).toEqual(jobs.map(job => job.id));
    restored.reorderPending(jobs[1].id, jobs[0].id);
    expect(new JobQueue(root).listProjectExecutionOrder("project").map(job => job.id)).toEqual([jobs[1].id, jobs[0].id]);
  });
});
