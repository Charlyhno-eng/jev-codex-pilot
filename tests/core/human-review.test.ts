import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobQueue } from "../../src/core/queue.js";
import { Orchestrator } from "../../src/core/orchestrator.js";
import type { Job } from "../../src/core/types.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(enabled: boolean, status: "SUCCESS" | "FAILED" = "SUCCESS") {
  const root = mkdtempSync(join(tmpdir(), "jev-human-review-"));
  roots.push(root);
  const queue = new JobQueue(root);
  const jobs = queue.createBatch("review-project", root, [{ description: "First" }, { description: "Second" }]);
  const orchestrator = new Orchestrator(queue);
  orchestrator.configureHumanReview(() => enabled);
  const run = vi.spyOn(orchestrator as unknown as { runWithEscalation(job: Job): Promise<Job> }, "runWithEscalation")
    .mockImplementation(async job => queue.transition(job.id, status)!);
  return { root, queue, jobs, orchestrator, run };
}

describe("between-ticket human review", () => {
  it.each(["SUCCESS", "FAILED"] as const)("pauses after %s and continues only after approval", async status => {
    const { root, queue, jobs, orchestrator, run } = fixture(true, status);
    await orchestrator.runBatch(jobs[0].id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.get(jobs[0].id)?.awaitingHumanReview).toBe(true);
    expect(queue.get(jobs[1].id)?.status).toBe("PENDING");
    expect(new JobQueue(root).get(jobs[0].id)?.awaitingHumanReview).toBe(true);
    await expect(orchestrator.runBatch(jobs[1].id)).rejects.toThrow("Approve");
    await expect(orchestrator.run(jobs[1].id)).rejects.toThrow("Approve");
    orchestrator.approveHumanReview("review-project");
    await orchestrator.runBatch(jobs[1].id);
    expect(run).toHaveBeenCalledTimes(2);
    expect(queue.get(jobs[1].id)?.awaitingHumanReview).toBe(true);
  });
  it("executes the saved pending order across batches after a restart", async () => {
    const { root, queue, jobs } = fixture(false);
    const later = queue.create("review-project", root, [{ description: "Later batch" }]);
    queue.reorderPending(later.id, jobs[0].id);
    queue.reorderPending(jobs[0].id, null);
    const restored = new JobQueue(root);
    const orchestrator = new Orchestrator(restored);
    const run = vi.spyOn(orchestrator as unknown as { runWithEscalation(job: Job): Promise<Job> }, "runWithEscalation")
      .mockImplementation(async job => restored.transition(job.id, "SUCCESS")!);
    await orchestrator.runBatch(jobs[0].id);
    expect(run.mock.calls.map(([job]) => job.id)).toEqual([later.id, jobs[1].id, jobs[0].id]);
  });
  it.each([true, false])("applies human review changed to %s during execution", async enabled => {
    const { jobs, queue, orchestrator, run } = fixture(!enabled);
    let reviewEnabled = !enabled;
    orchestrator.configureHumanReview(() => reviewEnabled);
    run.mockImplementation(async job => {
      reviewEnabled = enabled;
      return queue.transition(job.id, "SUCCESS")!;
    });
    await orchestrator.runBatch(jobs[0].id);
    expect(run).toHaveBeenCalledTimes(enabled ? 1 : 2);
    expect(Boolean(queue.get(jobs[0].id)?.awaitingHumanReview)).toBe(enabled);
  });
  it("keeps automatic sequencing when disabled", async () => {
    const { jobs, orchestrator, run } = fixture(false);
    await orchestrator.runBatch(jobs[0].id);
    expect(run).toHaveBeenCalledTimes(2);
    expect(orchestrator.needsHumanReview("review-project")).toBe(false);
  });
  it.each([false, true])("handles a failed automatic Git commit with human review %s", async enabled => {
    const { jobs, queue, orchestrator, run } = fixture(enabled);
    run.mockImplementation(async job => queue.transition(job.id, "SUCCESS", {
      gitDelivery: { status: "failed", error: "HEAD changed during the ticket. Review the repository before automatic Git delivery." }
    })!);
    await orchestrator.runBatch(jobs[0].id);
    expect(run).toHaveBeenCalledTimes(enabled ? 1 : 2);
    expect(queue.get(jobs[0].id)).toMatchObject({ status: "SUCCESS", gitDelivery: { status: "failed" } });
    expect(queue.get(jobs[1].id)?.status).toBe(enabled ? "PENDING" : "SUCCESS");
  });
  it("continues pending tickets after a startup failure", async () => {
    const { jobs, queue, orchestrator, run } = fixture(false);
    run.mockRejectedValueOnce(new Error("Startup failure"));
    await orchestrator.runBatch(jobs[0].id);
    expect(queue.get(jobs[0].id)).toMatchObject({ status: "FAILED", error: "Startup failure" });
    expect(queue.get(jobs[1].id)?.status).toBe("SUCCESS");
    expect(run).toHaveBeenCalledTimes(2);
    expect(orchestrator.ownsProjectRun(jobs[0].projectId)).toBe(false);
  });
  it("waits for session availability before starting later tickets", async () => {
    const { jobs, queue, orchestrator, run } = fixture(false);
    run.mockImplementationOnce(async job => queue.transition(job.id, "SESSION_PAUSED")!);
    await orchestrator.runBatch(jobs[0].id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.get(jobs[1].id)?.status).toBe("PENDING");
  });
  it("retries a corrected ticket before later pending work", async () => {
    const { jobs, queue, orchestrator, run } = fixture(true, "FAILED");
    await orchestrator.runBatch(jobs[0].id);
    queue.moveManually(jobs[0].id, "PENDING");
    queue.updatePendingTask(jobs[0].id, "Corrected request");
    expect(orchestrator.needsHumanReview("review-project")).toBe(true);
    orchestrator.approveHumanReview("review-project");
    await orchestrator.runBatch(jobs[1].id);
    expect(run.mock.calls[1][0].id).toBe(jobs[0].id);
    expect(queue.get(jobs[1].id)?.status).toBe("PENDING");
  });
  it("records a review pause on an execution error", async () => {
    const { jobs, queue, orchestrator, run } = fixture(true);
    run.mockRejectedValueOnce(new Error("Startup failure"));
    await orchestrator.runBatch(jobs[0].id);
    expect(queue.get(jobs[0].id)).toMatchObject({ status: "FAILED", awaitingHumanReview: true });
    expect(queue.get(jobs[1].id)?.status).toBe("PENDING");
  });
});
