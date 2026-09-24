import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexModel, Complexity, Job, JobStatus, Reasoning, TaskSpec } from "./types.js";
import { codexModelId, defaultRoute, MODEL_LEVELS, REASONING_LEVELS, routesForComplexity } from "./codex-models.js";
import { readDurableJson, writeDurableJson } from "./durable-json.js";
import { implementationBlocked } from "./codex-execution.js";


const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validJobs = (value: unknown): value is Job[] => Array.isArray(value) && value.every(job => isRecord(job) && typeof job.id === "string" && typeof job.projectId === "string" && typeof job.projectPath === "string" && Array.isArray(job.tasks) && job.tasks.every((task: unknown) => isRecord(task) && typeof task.description === "string") && ["PENDING", "RUNNING", "ESCALATING", "SESSION_PAUSED", "SUCCESS", "FAILED", "SKIPPED"].includes(String(job.status)) && typeof job.createdAt === "string" && Number.isInteger(job.attempts) && (!job.execution || isRecord(job.execution) && Array.isArray(job.execution.events)));

/** Persists and updates ticket queue state. */
export class JobQueue {
  private jobs: Job[] = [];
  private readonly file: string;
  constructor(dataDirectory = ".jev") {
    mkdirSync(dataDirectory, { recursive: true });
    this.file = join(dataDirectory, "jobs.json");
    this.jobs = readDurableJson(this.file, validJobs, () => []);
    this.jobs = this.jobs.map(job => {
      const current = { ...job } as Job & Record<string, unknown>;
      delete current["fixedOrder"];
      delete current["submittedOrder"];
      return current;
    });
    this.jobs = this.jobs.map(job => {
      if (job.analysis) {
        const old = job.analysis as unknown as Record<string, unknown>;
        const legacy: Record<string, Complexity> = { trivial: 1, low: 1, medium: 2, high: 4, very_high: 5 };
        const rawComplexity = old.complexity;
        const complexity = typeof rawComplexity === "string"
          ? legacy[rawComplexity] ?? 2
          : typeof rawComplexity === "number" && Number.isFinite(rawComplexity)
            ? Math.max(1, Math.min(5, Math.round(rawComplexity))) as Complexity
            : 2;
        if (complexity !== rawComplexity || old.independent_delivery_score !== undefined) {
          const { independent_delivery_score: _removed, ...analysis } = old;
          job = { ...job, analysis: { ...analysis, complexity } as unknown as typeof job.analysis };
        }
      }
      if (job.status === "PENDING" && job.analysis && !job.execution?.escalationPending) {
        const routes = routesForComplexity(job.analysis.complexity);
        if (!routes.some(route => route.model === job.analysis!.model && route.reasoning === job.analysis!.reasoning)) {
          const route = defaultRoute(job.analysis.complexity);
          job = { ...job, analysis: { ...job.analysis, ...route, rationale: [...job.analysis.rationale, "Pending recommendation refreshed from config/model.toml."] } };
        }
      }
      if (job.status === "SUCCESS" && implementationBlocked(job.output ?? "")) {
        return { ...job, status: "FAILED", errorCategory: "code", updatedAt: new Date().toISOString(), error: "Codex reported that it could not implement the task", execution: job.execution ? { ...job.execution, phase: "ERROR" } : undefined } as Job;
      }
      return job;
    });
    this.persist();
  }
  private persist() {
    writeDurableJson(this.file, this.jobs);
  }
  list(projectId?: string): Job[] { return this.jobs.filter(job => !projectId || job.projectId === projectId).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || (a.order ?? 0) - (b.order ?? 0)); }
  listProjectExecutionOrder(projectId: string): Job[] {
    return this.jobs
      .map((job, index) => ({ job, index }))
      .filter(entry => entry.job.projectId === projectId)
      .sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt) || (a.job.batchId === b.job.batchId ? (a.job.order ?? a.index) - (b.job.order ?? b.index) : a.index - b.index))
      .map(entry => entry.job);
  }
  get(id: string) { return this.jobs.find(j => j.id === id); }
  listBatch(batchId: string): Job[] { return this.jobs.filter(job => job.batchId === batchId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); }
  create(projectId: string, projectPath: string, tasks: TaskSpec[]): Job {
    return this.createBatch(projectId, projectPath, tasks)[0];
  }
  /** Creates independently queued tickets in their submitted order. */
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
  /** Archives every saved ticket entry that belongs to a cleared Codex thread. */
  clearProjectThread(projectId: string, threadId: string, detail = "JEV cleared this project thread; the next task starts a fresh Codex conversation.") {
    const now = new Date().toISOString();
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
  /** Prevents JEV from resuming a thread whose automatic archive failed. */
  disableProjectThreadResume(projectId: string, threadId: string) {
    const now = new Date().toISOString();
    this.jobs = this.jobs.map(job => job.projectId !== projectId || job.execution?.threadId !== threadId ? job : {
      ...job,
      execution: { ...job.execution, threadResumeDisabledAt: now }
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
  /** Recovers work only when its former Codex process is no longer alive. */
  recoverInterrupted(isActive: (pid: number) => boolean, owned: (projectId: string) => boolean = () => false): Job[] {
    const recovered: Job[] = [];
    for (const job of this.jobs.filter(item => (item.status === "RUNNING" || item.status === "ESCALATING") && !owned(item.projectId))) {
      if (job.execution?.pid && isActive(job.execution.pid)) {
        if (!job.recoveryNote) this.update(job.id, { errorCategory: "interruption", recoveryNote: "Server restarted while the previous Codex process is still active. Waiting for that process to exit before allowing a new launch." });
        continue;
      }
      const now = new Date().toISOString();
      const wasEscalating = job.status === "ESCALATING" || job.execution?.escalationPending;
      const note = wasEscalating
        ? "JEV was interrupted during model escalation. Review the partial work before resuming at the selected route."
        : "Server execution was interrupted. Codex is no longer running; review the project before restarting this ticket.";
      const updated = this.update(job.id, { status: "PENDING", error: undefined, errorCategory: "interruption", recoveryNote: note, execution: job.execution ? { ...job.execution, phase: "QUEUED", pid: undefined, lastActivityAt: now, completedAt: undefined, events: [...job.execution.events, { id: randomUUID(), timestamp: now, kind: "system", title: wasEscalating ? "Escalation interrupted" : "Execution interrupted", detail: note, status: "active" }] } : undefined });
      if (updated) recovered.push(updated);
    }
    return recovered;
  }
  pauseForSessionLimit(id: string, resumeAt?: string) {
    const job = this.get(id);
    if (!job) throw new Error("Job not found");
    const now = new Date().toISOString();
    const event = {
      id: randomUUID(),
      timestamp: now,
      kind: "system" as const,
      title: "Codex session limit reached",
      detail: resumeAt ? `Development paused until Codex can start its next session at ${resumeAt}.` : "Development paused until Codex can start its next session.",
      status: "active" as const
    };
    return this.update(id, {
      status: "SESSION_PAUSED",
      error: undefined,
      errorCategory: "quota",
      sessionResumeAt: resumeAt,
      execution: job.execution ? { ...job.execution, phase: "QUEUED", lastActivityAt: now, completedAt: now, events: [...job.execution.events, event] } : undefined
    });
  }
  resumeSessionPaused(id: string) {
    const job = this.get(id);
    if (!job) throw new Error("Job not found");
    if (job.status !== "SESSION_PAUSED") throw new Error("Only session-paused tasks can resume");
    const now = new Date().toISOString();
    const event = { id: randomUUID(), timestamp: now, kind: "system" as const, title: "Codex session available", detail: "Development automatically resumed after the Codex session limit reset.", status: "active" as const };
    return this.update(id, {
      status: "PENDING",
      errorCategory: undefined,
      sessionResumeAt: undefined,
      execution: job.execution ? { ...job.execution, phase: "QUEUED", lastActivityAt: now, completedAt: undefined, events: [...job.execution.events, event] } : undefined
    });
  }
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
    const retryRoute = status === "PENDING" && job.analysis && !routesForComplexity(job.analysis.complexity).some(route => route.model === job.analysis!.model && route.reasoning === job.analysis!.reasoning)
      ? defaultRoute(job.analysis.complexity)
      : undefined;
    return this.update(id, {
      status,
      analysis: retryRoute && job.analysis ? { ...job.analysis, ...retryRoute, rationale: [...job.analysis.rationale, "Manual retry restarted at the complexity default route."] } : job.analysis,
      error: undefined,
      errorCategory: undefined,
      recoveryNote: undefined,
      archivedAt: undefined,
      execution: job.execution ? {
        ...job.execution,
        escalationPending: false,
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
    return this.update(id, { tasks: [{ description: text }], analysis: undefined, error: undefined, errorCategory: undefined, recoveryNote: undefined });
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
      errorCategory: undefined,
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
    const allowedRoutes = routesForComplexity(job.analysis.complexity);
    const levels = dimension === "model"
      ? MODEL_LEVELS.filter(model => allowedRoutes.some(route => route.model === model))
      : REASONING_LEVELS.filter(reasoning => allowedRoutes.some(route => route.model === job.analysis!.model && route.reasoning === reasoning));
    const current = job.analysis[dimension] as CodexModel | Reasoning;
    const configuredIndex = levels.indexOf(current as never);
    const index = configuredIndex < 0 ? (dimension === "reasoning" && current === "max" ? levels.length - 1 : dimension === "reasoning" && current === "xhigh" ? Math.max(0, levels.length - 2) : 0) : configuredIndex;
    const requestedIndex = Math.max(0, Math.min(levels.length - 1, index + delta));
    const next = levels[requestedIndex];
    if (next === current) return job;
    const direction = delta < 0 ? "lower" : "higher";
    const label = dimension === "model" ? codexModelId(next as CodexModel) : next === "xhigh" ? "Extra high" : next === "max" ? "Max" : next;
    const pairedReasoning = dimension === "model"
      ? allowedRoutes.find(route => route.model === next && route.reasoning === job.analysis!.reasoning)?.reasoning ?? allowedRoutes.find(route => route.model === next)?.reasoning ?? job.analysis.reasoning
      : job.analysis.reasoning;
    return this.update(id, {
      analysis: {
        ...job.analysis,
        [dimension]: next,
        reasoning: dimension === "model" ? pairedReasoning : next as Reasoning,
        rationale: [...job.analysis.rationale, `Manual JEV tuning: ${dimension} moved one level ${direction} to ${label}.${dimension === "model" && pairedReasoning !== job.analysis.reasoning ? " Reasoning was adjusted to that model's supported policy range." : ""}`]
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
