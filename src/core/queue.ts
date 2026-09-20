import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexModel, Job, JobStatus, Reasoning, TaskSpec } from "./types.js";

const MODEL_LEVELS: CodexModel[] = ["luna", "terra", "sol"];
const REASONING_LEVELS: Reasoning[] = ["low", "medium", "high", "xhigh"];

type ProjectThreadState = {
  activeThreadId?: string;
  successfulSinceCompaction: number;
};

export class JobQueue {
  private jobs: Job[] = [];
  private readonly file: string;
  private readonly threadStateFile: string;
  private threadStates: Record<string, ProjectThreadState> = {};
  constructor(dataDirectory = ".jev") {
    mkdirSync(dataDirectory, { recursive: true });
    this.file = join(dataDirectory, "jobs.json");
    this.threadStateFile = join(dataDirectory, "thread-state.json");
    if (existsSync(this.file)) this.jobs = JSON.parse(readFileSync(this.file, "utf8"));
    if (existsSync(this.threadStateFile)) this.threadStates = JSON.parse(readFileSync(this.threadStateFile, "utf8"));
    this.jobs = this.jobs.map(job => {
      if (job.status === "RUNNING") return { ...job, status: "PENDING", updatedAt: new Date().toISOString(), error: "Execution interrupted; the job is ready to resume.", execution: job.execution ? { ...job.execution, phase: "ERROR", completedAt: new Date().toISOString() } : undefined } as Job;
      if (job.status === "SUCCESS" && /patch rejected|writing is blocked|impossible d['’]implémenter|could not implement|unable to implement/i.test(job.output ?? "")) {
        return { ...job, status: "FAILED", updatedAt: new Date().toISOString(), error: "Codex reported that it could not implement the task", execution: job.execution ? { ...job.execution, phase: "ERROR" } : undefined } as Job;
      }
      return job;
    });
    this.persist();
  }
  private persist() {
    writeFileSync(this.file, JSON.stringify(this.jobs, null, 2));
    writeFileSync(this.threadStateFile, JSON.stringify(this.threadStates, null, 2));
  }
  private threadState(projectId: string): ProjectThreadState {
    const existing = this.threadStates[projectId];
    if (existing) return existing;
    const successfulSinceCompaction = this.jobs.filter(job => job.projectId === projectId && job.status === "SUCCESS").length % 3;
    const activeThreadId = this.jobs
      .filter(job => job.projectId === projectId && job.status === "SUCCESS" && job.execution?.threadId && !job.execution.threadArchivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.execution?.threadId;
    return this.threadStates[projectId] = { activeThreadId, successfulSinceCompaction };
  }
  list(projectId?: string): Job[] { return this.jobs.filter(job => !projectId || job.projectId === projectId).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || (a.order ?? 0) - (b.order ?? 0)); }
  listProjectExecutionOrder(projectId: string): Job[] {
    return this.jobs
      .map((job, index) => ({ job, index }))
      .filter(entry => entry.job.projectId === projectId)
      .sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt) || a.index - b.index)
      .map(entry => entry.job);
  }
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
  recordProjectThread(projectId: string, threadId: string) {
    const state = this.threadState(projectId);
    state.activeThreadId = threadId;
    this.persist();
  }
  activeProjectThread(projectId: string) {
    const state = this.threadState(projectId);
    if (state.activeThreadId) return state.activeThreadId;
    const threadId = this.jobs
      .filter(job => job.projectId === projectId && job.status === "SUCCESS" && job.execution?.threadId && !job.execution.threadArchivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.execution?.threadId;
    if (threadId) { state.activeThreadId = threadId; this.persist(); }
    return threadId;
  }
  successesSinceCompaction(projectId: string) { return this.threadState(projectId).successfulSinceCompaction; }
  recordSuccessfulTasks(projectId: string, count: number) {
    const state = this.threadState(projectId);
    state.successfulSinceCompaction += count;
    this.persist();
    return state.successfulSinceCompaction;
  }
  markProjectCompacted(projectId: string) {
    this.threadState(projectId).successfulSinceCompaction = 0;
    this.persist();
  }
  clearProjectThread(projectId: string, threadId: string, detail = "The user cleared this project thread; the next task starts a fresh Codex conversation.") {
    const now = new Date().toISOString();
    const state = this.threadState(projectId);
    if (state.activeThreadId === threadId) state.activeThreadId = undefined;
    state.successfulSinceCompaction = 0;
    this.jobs = this.jobs.map(job => job.projectId !== projectId || job.execution?.threadId !== threadId ? job : {
      ...job,
      execution: {
        ...job.execution,
        threadArchivedAt: now,
        events: [...job.execution.events, { id: randomUUID(), timestamp: now, kind: "system" as const, title: "Codex /clear confirmed", detail, status: "success" as const }]
      }
    });
    this.persist();
  }
  appendProjectThreadEvent(projectId: string, threadId: string, title: string, detail: string, status: "active" | "success" | "error" = "success") {
    const now = new Date().toISOString();
    this.jobs = this.jobs.map(job => job.projectId !== projectId || job.execution?.threadId !== threadId ? job : {
      ...job,
      execution: { ...job.execution, lastActivityAt: now, events: [...job.execution.events, { id: randomUUID(), timestamp: now, kind: status === "error" ? "error" as const : "system" as const, title, detail, status }] }
    });
    this.persist();
  }
  transition(id: string, status: JobStatus, more: Partial<Job> = {}) { return this.update(id, { ...more, status }); }
  moveManually(id: string, status: "PENDING" | "SUCCESS") {
    const job = this.get(id);
    if (!job) throw new Error("Job not found");
    const allowed = (job.status === "FAILED" && (status === "PENDING" || status === "SUCCESS")) || (job.status === "SUCCESS" && status === "PENDING");
    if (!allowed) throw new Error("Only failed tasks, or successful tasks returned to pending, can be moved manually");
    const now = new Date().toISOString();
    const event = {
      id: randomUUID(),
      timestamp: now,
      kind: "system" as const,
      title: status === "SUCCESS" ? "Task manually validated" : "Task returned to pending",
      detail: status === "SUCCESS" ? "A user confirmed that this task is complete." : `A user returned this ${job.status.toLowerCase()} task to the pending column.`,
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
  updatePendingTask(id: string, description: string) {
    const job = this.get(id);
    if (!job) throw new Error("Job not found");
    if (job.status !== "PENDING") throw new Error("Only pending tasks can be edited");
    const text = description.trim();
    if (!text) throw new Error("A task description is required");
    return this.update(id, { tasks: [{ description: text }], analysis: undefined, error: undefined });
  }
  scheduleAutomaticRetry(id: string, completedTaskDescription: string) {
    const job = this.get(id);
    if (!job) throw new Error("Job not found");
    if (job.status !== "FAILED") throw new Error("Only failed tasks can be scheduled for an automatic retry");
    const now = new Date().toISOString();
    const event = {
      id: randomUUID(),
      timestamp: now,
      kind: "system" as const,
      title: "Automatic retry scheduled",
      detail: `A later task completed successfully: ${completedTaskDescription}`,
      status: "active" as const
    };
    return this.update(id, {
      status: "PENDING",
      error: undefined,
      execution: job.execution ? {
        ...job.execution,
        phase: "QUEUED",
        lastActivityAt: now,
        completedAt: undefined,
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
  removePending(id: string) {
    const index = this.jobs.findIndex(job => job.id === id);
    if (index < 0) return undefined;
    if (this.jobs[index].status !== "PENDING") throw new Error("Only pending tasks can be removed");
    const [removed] = this.jobs.splice(index, 1);
    this.persist();
    return removed;
  }
  clear() { this.jobs = []; this.persist(); }
}
