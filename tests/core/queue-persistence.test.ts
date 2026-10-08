import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobQueue } from "../../src/core/queue.js";
import type { Job } from "../../src/core/types.js";

describe("live telemetry persistence", () => {
  let root: string;
  afterEach(() => { vi.useRealTimers(); if (root) rmSync(root, { recursive: true, force: true }); });
  const setup = () => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), "jev-live-queue-"));
    const queue = new JobQueue(root);
    const jobs = queue.createBatch("project", root, [{ description: "First" }, { description: "Second" }]);
    const saved = () => JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")) as Job[];
    return { queue, jobs, saved };
  };
  it("groups a burst across tickets and saves the latest in-memory state", () => {
    const { queue, jobs, saved } = setup();
    for (let index = 0; index < 100; index++) queue.update(jobs[index % 2].id, { output: `line ${index}` }, true);
    expect(queue.get(jobs[1].id)?.output).toBe("line 99");
    expect(saved()[1].output).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    expect(saved().map(job => job.output)).toEqual(["line 98", "line 99"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("flushes buffered logs with the final transition and cancels the pending write", () => {
    const { queue, jobs, saved } = setup();
    queue.update(jobs[0].id, { output: "last event" }, true);
    queue.transition(jobs[0].id, "SUCCESS");
    expect(saved()[0]).toMatchObject({ output: "last event", status: "SUCCESS" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("flushes live state explicitly during shutdown", () => {
    const { queue, jobs, saved } = setup();
    queue.update(jobs[0].id, { output: "pending telemetry" }, true);
    queue.flush();
    expect(saved()[0].output).toBe("pending telemetry");
    expect(vi.getTimerCount()).toBe(0);
    queue.flush();
    expect(vi.getTimerCount()).toBe(0);
  });
});
