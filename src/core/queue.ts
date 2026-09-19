import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexModel, Job, JobStatus, Reasoning, TaskSpec } from "./types.js";

const MODEL_LEVELS: CodexModel[] = ["luna", "terra", "sol"];
const REASONING_LEVELS: Reasoning[] = ["low", "medium", "high", "xhigh"];

export class JobQueue {
  private jobs: Job[] = [];
  private readonly file: string;
  constructor(dataDirectory = ".jev") {
    mkdirSync(dataDirectory, { recursive: true });
    this.file = join(dataDirectory, "jobs.json");
    if (existsSync(this.file)) this.jobs = JSON.parse(readFileSync(this.file, "utf8"));
    this.jobs = this.jobs.map(job => {
      if (job.status === "RUNNING") return { ...job, status: "PENDING", updatedAt: new Date().toISOString(), error: "Execution interrupted; the job is ready to resume.", execution: job.execution ? { ...job.execution, phase: "ERROR", completedAt: new Date().toISOString() } : undefined } as Job;
      if (job.status === "SUCCESS" && /patch rejected|writing is blocked|impossible d['’]implémenter|could not implement|unable to implement/i.test(job.output ?? "")) {
        return { ...job, status: "FAILED", updatedAt: new Date().toISOString(), error: "Codex reported that it could not implement the task", execution: job.execution ? { ...job.execution, phase: "ERROR" } : undefined } as Job;
      }
      return job;
    });
    this.persist();
  }
  private persist() { writeFileSync(this.file, JSON.stringify(this.jobs, null, 2)); }
  list(projectId?: string): Job[] { return this.jobs.filter(job => !projectId || job.projectId === projectId).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || (a.order ?? 0) - (b.order ?? 0)); }
  get(id: string) { return this.jobs.find(j => j.id === id); }
  listBatch(batchId: string): Job[] { return this.jobs.filter(job => job.batchId === batchId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); }
  create(projectId: string, projectPath: string, tasks: TaskSpec[]): Job {
    return this.createBatch(projectId, projectPath, tasks)[0];
  }
  createBatch(projectId: string, projectPath: string, tasks: TaskSpec[]): Job[] {
    const now = new Date().toISOString();
    const batchId = randomUUID();
    const jobs = tasks.map((task, order): Job => ({ id: randomUUID(), projectId, batchId, order, projectPath: resolve(projectPath), tasks: [task], status: "PENDING", createdAt: now, updatedAt: now, attempts: 0 }));
    this.jobs.push(...jobs); this.persist(); return jobs;
  }
  update(id: string, change: Partial<Job>): Job | undefined {
    const index = this.jobs.findIndex(j => j.id === id); if (index < 0) return undefined;
    this.jobs[index] = { ...this.jobs[index], ...change, updatedAt: new Date().toISOString() }; this.persist(); return this.jobs[index];
  }
  transition(id: string, status: JobStatus, more: Partial<Job> = {}) { return this.update(id, { ...more, status }); }
  moveFailed(id: string, status: "PENDING" | "SUCCESS") {
    const job = this.get(id);
    if (!job) throw new Error("Job not found");
    if (job.status !== "FAILED") throw new Error("Only failed tasks can be moved manually");
    const now = new Date().toISOString();
    const event = {
      id: randomUUID(),
      timestamp: now,
      kind: "system" as const,
      title: status === "SUCCESS" ? "Task manually validated" : "Task returned to pending",
      detail: status === "SUCCESS" ? "A user confirmed that this task is complete." : "A user returned this failed task to the pending column.",
      status: "success" as const
    };
    return this.update(id, {
      status,
      error: undefined,
      archivedAt: undefined,
      execution: job.execution ? {
        ...job.execution,
        phase: status === "SUCCESS" ? "COMPLETED" : "ERROR",
        completedAt: status === "SUCCESS" ? (job.execution.completedAt ?? now) : undefined,
        events: [...job.execution.events, event]
      } : undefined
    });
  }
  adjustAnalysis(id: string, dimension: "model" | "reasoning", delta: -1 | 1) {
    const job = this.get(id);
    if (!job) throw new Error("Job not found");
    if (job.status !== "PENDING") throw new Error("Only pending tasks can be adjusted");
    if (!job.analysis) throw new Error("Analyze this task before adjusting its recommendation");
    const levels = dimension === "model" ? MODEL_LEVELS : REASONING_LEVELS;
    const current = job.analysis[dimension] as CodexModel | Reasoning;
    const index = levels.indexOf(current as never);
    if (index < 0) throw new Error(`Unknown ${dimension} recommendation`);
    const nextIndex = Math.max(0, Math.min(levels.length - 1, index + delta));
    const next = levels[nextIndex];
    if (next === current) return job;
    const direction = delta < 0 ? "lower" : "higher";
    const label = dimension === "model" ? `gpt-5.6-${next}` : next === "xhigh" ? "Extra high" : next;
    return this.update(id, {
      analysis: {
        ...job.analysis,
        [dimension]: next,
        rationale: [...job.analysis.rationale, `Manual JEV tuning: ${dimension} moved one level ${direction} to ${label}.`]
      }
    });
  }
  archive(id: string) {
    const job = this.get(id);
    if (!job) return undefined;
    if (job.status !== "SUCCESS") throw new Error("Only successful tasks can be archived");
    return this.update(id, { archivedAt: new Date().toISOString() });
  }
  unarchive(id: string) {
    const job = this.get(id);
    if (!job) return undefined;
    return this.update(id, { archivedAt: undefined });
  }
  clear() { this.jobs = []; this.persist(); }
}
