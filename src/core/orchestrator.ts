import { randomUUID } from "node:crypto";
import { clampModelReasoning, nextEscalationRoute, reasoningAt, reasoningIndex } from "./model-routing.js";
import { existsSync, writeFileSync } from "node:fs";
import { withJevTimeout } from "./jev-timeout.js";
import { analyze, assessTaskContinuity } from "./analyzer.js";
import { logJev, logJevApplied, logJevError, logSession } from "./jev-logger.js";
import { buildExecutionPrompt } from "./prompt.js";
import { changedProjectFiles, snapshotProject } from "./project-snapshot.js";
import { commitMessageFromOutput, deliverGitTicket, prepareGitDelivery } from "./git-workspace.js";
import type { JobQueue } from "./queue.js";
import type { ExecutionUsage, ExecutionEvent, Job, ExecutionStatusSnapshot, Reasoning } from "./types.js";
import { createExecutionProvider } from "./execution/provider.js";
import type { ExecutionProvider, ExecutionResult, ExecutionUpdate } from "./execution/types.js";
import { readJevUsageFile, withTicketJevUsage } from "./jev-usage.js";
import { estimateJevInputCost } from "./jev-pricing.js";
import { ensureProjectLinterTicket, missingProjectLinters } from "./project-linter.js";

type Verification = NonNullable<Job["execution"]>["verification"];
const AUTO_COMPACTION_CONTEXT_TOKENS = 100_000;
function totalExecutionTokens(usage?: ExecutionUsage) {
  if (!usage) return undefined;
  const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  return total > 0 ? total : undefined;
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function estimateExecutionTokens(prompt: string, job: Job, reasoning: Reasoning, history: Job[]) {
  const promptTokens = Math.ceil(prompt.length / 4);
  const complexityReserve: Record<number, number> = { 1: 300, 2: 700, 3: 1_100, 4: 1_800, 5: 4_500 };
  const reasoningReserve: Record<string, number> = { low: 300, medium: 700, high: 1_400, xhigh: 2_500, max: 4_000 };
  const workReserve = complexityReserve[Number(job.analysis!.complexity)] ?? 1_800;
  const effortReserve = reasoningReserve[reasoning] ?? 300 + reasoningIndex(reasoning) * 500;
  const scopeEstimate = Math.max(1_000, Math.ceil((promptTokens + workReserve + effortReserve + 500) / 100) * 100);
  const comparable = history
    .map(job => job.execution?.metrics ? { ...job.execution.metrics, actualTokens: totalExecutionTokens(job.execution.usage) ?? job.execution.metrics.actualTokens } : undefined)
    .filter((metrics): metrics is NonNullable<typeof metrics> => Boolean(metrics?.actualTokens && metrics.estimatedTokens))
    .slice(0, 12);
  if (!comparable.length) return { tokens: scopeEstimate, basis: "scope" as const };
  const priorActual = median(comparable.map(metrics => metrics.actualTokens!));
  const priorScope = median(comparable.map(metrics => metrics.estimatedTokens));
  const calibrated = Math.round(priorActual * Math.max(.5, Math.min(2, scopeEstimate / Math.max(1, priorScope))) / 100) * 100;
  return { tokens: Math.max(scopeEstimate, calibrated), basis: "project_history" as const };
}

function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }

/** Dependencies selected by the application rather than embedded in ticket execution. */
export interface OrchestratorOptions {
  provider?: ExecutionProvider;
  analyzer?: typeof analyze;
  continuityReviewer?: typeof assessTaskContinuity;
}

/** Prepares queued tickets and runs each task through the selected coding AI. */
export class Orchestrator {
  private preparations = new Map<string, Promise<Job | undefined>>();
  private runningProjects = new Set<string>();
  private runningTickets = new Set<string>();
  private gitActions = new Set<string>();
  private continuityDecisions = new Map<string, "related" | "unrelated" | "uncertain">();
  private humanReviewEnabled: (projectId: string) => boolean = () => false;
  private autoGitEnabled: (projectId: string) => boolean = () => false;
  private readonly provider: ExecutionProvider;
  private readonly analyzer: typeof analyze;
  private readonly continuityReviewer: typeof assessTaskContinuity;
  constructor(private queue: JobQueue, options: OrchestratorOptions = {}) {
    this.provider = options.provider ?? createExecutionProvider();
    this.analyzer = options.analyzer ?? analyze;
    this.continuityReviewer = options.continuityReviewer ?? assessTaskContinuity;
  }

  /** Connects persisted project Git preferences to ticket execution. */
  configureGitDelivery(enabled: (projectId: string) => boolean) { this.autoGitEnabled = enabled; }

  /** Connects the persisted human review preference to execution. */
  configureHumanReview(enabled: (projectId: string) => boolean) { this.humanReviewEnabled = enabled; }

  /** Reserves a project's execution slot for an explicit Git action. */
  async withProjectGitAction<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    if (this.isProjectRunning(projectId)) throw new Error(`A ${this.provider.label} execution or Git action is already running for this project`);
    this.gitActions.add(projectId);
    try { return await run(); }
    finally { this.gitActions.delete(projectId); }
  }

  /** Reports whether a project is waiting for explicit user approval. */
  needsHumanReview(projectId: string) {
    return this.humanReviewEnabled(projectId) && this.queue.list(projectId).some(job => job.awaitingHumanReview);
  }

  /** Approves the previous ticket before the next explicit launch. */
  approveHumanReview(projectId: string) {
    if (this.isProjectRunning(projectId)) throw new Error("Wait for the active ticket to finish");
    for (const job of this.queue.list(projectId)) {
      if (job.awaitingHumanReview) this.queue.update(job.id, { awaitingHumanReview: false });
    }
  }

  private refreshJevUsage(id: string) {
    const usage = readJevUsageFile(this.queue.jevUsageFile(id));
    this.queue.update(id, { jevUsage: { ...usage, estimatedCostUsd: usage.missingCalls ? undefined : estimateJevInputCost(usage.inputTokens) } });
  }

  private async trackJevUsage<T>(job: Job, run: () => Promise<T>): Promise<T> {
    const file = this.queue.jevUsageFile(job.id);
    if (!existsSync(file)) {
      // Older tickets have no complete telemetry; preserve that uncertainty.
      writeFileSync(file, job.analysis ? "{}\n" : "", { mode: 0o600 });
    }
    try { return await withTicketJevUsage(file, run); }
    finally { this.refreshJevUsage(job.id); }
  }

  /** Evaluates a pending ticket and persists its JEV consumption. */
  async prepare(job: Job): Promise<Job | undefined> {
    const current = this.queue.get(job.id);
    if (!current) throw new Error("Job not found");
    if (current.analysis) return current;
    const key = JSON.stringify([current.id, current.tasks]);
    const existing = this.preparations.get(key);
    if (existing) return existing;
    const preparation = this.trackJevUsage(current, () => this.prepareTicket(current))
      .finally(() => this.preparations.delete(key));
    this.preparations.set(key, preparation);
    return preparation;
  }

  private async prepareTicket(job: Job): Promise<Job | undefined> {
    if (!existsSync(job.projectPath)) throw new Error(`Project not found: ${job.projectPath}`);
    if (job.analysis) return job;
    try {
      const analysis = await withJevTimeout(() => this.analyzer(job.projectPath, job.tasks));
      const latest = this.queue.get(job.id);
      if (!latest) throw new Error("Job not found");
      if (JSON.stringify(latest.tasks) !== JSON.stringify(job.tasks)) return this.prepare(latest);
      if (latest.analysis) return latest;
      logJev(`JEV recommends ${this.provider.modelId(analysis.model)} with ${analysis.reasoning} reasoning for task ${job.id.slice(0, 8)} · expected outcome clarity ${analysis.outcome_clarity_score ?? "unavailable"}% · complexity ${analysis.complexity}/5`);
      return this.queue.update(job.id, { analysis, error: undefined, errorCategory: undefined });
    } catch (error) {
      logJevError(`Recommendation unavailable for task ${job.id.slice(0, 8)} · ${messageOf(error)}`);
      const latest = this.queue.get(job.id);
      if (latest?.analysis) return latest;
      if (latest && JSON.stringify(latest.tasks) !== JSON.stringify(job.tasks)) return this.prepare(latest);
      if (latest) this.queue.update(job.id, { error: messageOf(error), errorCategory: "jev" });
      throw error;
    }
  }

  isProjectRunning(projectId: string) { return this.runningProjects.has(projectId) || this.gitActions.has(projectId) || this.queue.list(projectId).some(job => job.status === "RUNNING" || job.status === "ESCALATING"); }
  /** Reports an active manual Git operation separately from ticket execution. */
  isProjectGitActionRunning(projectId: string) { return this.gitActions.has(projectId); }
  ownsProjectRun(projectId: string) { return this.runningProjects.has(projectId); }
  /** Protects the selected ticket from changes while it is preparing or executing. */
  ownsTicketRun(id: string) { return this.runningTickets.has(id); }

  private async taskContinuity(completed: Job[], next: Job) {
    const key = JSON.stringify({ completed: completed.map(job => [job.id, job.tasks]), next: [next.id, next.tasks] });
    const cached = this.continuityDecisions.get(key);
    if (cached) return cached;
    const decision = await withJevTimeout(() => this.continuityReviewer(completed, next));
    this.continuityDecisions.set(key, decision);
    if (this.continuityDecisions.size > 100) this.continuityDecisions.delete(this.continuityDecisions.keys().next().value!);
    return decision;
  }

  /** Resumes only quota-paused tickets belonging to the selected execution provider. */
  async resumeSessionPausedJobs() {
    const paused = this.queue.list().filter(job => job.status === "SESSION_PAUSED" && (job.execution?.providerId ?? "codex") === this.provider.id && !this.isProjectRunning(job.projectId));
    if (!paused.length) return [];
    const now = Date.now();
    const scheduled = paused.filter(job => job.sessionResumeAt && Date.parse(job.sessionResumeAt) <= now);
    const unscheduled = paused.filter(job => !job.sessionResumeAt);
    let eligible = scheduled;
    if (unscheduled.length) {
      const limits = await this.provider.readRateLimit().catch(error => ({ available: false, reached: false, unavailableReason: messageOf(error) }));
      if (limits.available && !limits.reached) eligible = [...scheduled, ...unscheduled];
    }
    if (!eligible.length) return [];
    for (const job of eligible) this.queue.resumeSessionPaused(job.id);
    const eligibleIds = new Set(eligible.map(job => job.id));
    return [...new Set(eligible.map(job => job.projectId))]
      .map(projectId => this.queue.listProjectExecutionOrder(projectId).find(job => eligibleIds.has(job.id)))
      .filter((job): job is Job => Boolean(job));
  }

  /** Builds a provider-owned launch preview without executing the ticket. */
  async command(job: Job) {
    const prepared = job.analysis ? job : (await this.prepare(job))!;
    return this.provider.command(prepared);
  }

  /** Drains the project's pending tickets in queue order, including arrivals during the run. */
  async runBatch(id: string): Promise<void> {
    const first = this.queue.get(id);
    if (!first) throw new Error("Job not found");
    if (this.isProjectRunning(first.projectId)) throw new Error(`A ${this.provider.label} execution is already running for this project`);
    if (this.needsHumanReview(first.projectId)) throw new Error("Approve the previous ticket before continuing");
    this.runningProjects.add(first.projectId);
    try {
      ensureProjectLinterTicket(this.queue, first.projectId, first.projectPath);
      const retried = new Set<string>();
      while (true) {
        const current = this.queue.listProjectExecutionOrder(first.projectId)
          .find(job => job.kind === "linter_setup" && !job.archivedAt && ["PENDING", "SESSION_PAUSED", "FAILED"].includes(job.status))
          ?? this.queue.listProjectExecutionOrder(first.projectId).find(job => job.status === "PENDING" || job.status === "SESSION_PAUSED");
        if (current?.kind === "linter_setup" && current.status === "FAILED") this.queue.moveManually(current.id, "PENDING");
        if (!current || current.status === "SESSION_PAUSED") break;
        try {
          const completed = await this.runWithEscalation(current);
          if (completed.status === "SESSION_PAUSED") break;
          if (this.humanReviewEnabled(first.projectId)) {
            this.queue.update(completed.id, { awaitingHumanReview: true });
            break;
          }
          if (completed.kind === "linter_setup" && completed.status !== "SUCCESS") break;
          if (completed.gitDelivery?.status === "failed") logJevError(`[${this.provider.id}:${completed.id.slice(0, 8)}] Automatic Git delivery failed: ${completed.gitDelivery.error ?? "unknown error"}. Continuing pending tickets.`);
          const lastOrder = completed.status === "SUCCESS" ? completed.order ?? Number.MAX_SAFE_INTEGER : -1;
          if (lastOrder < 0) continue;
          const failures = this.queue.listBatch(first.batchId ?? first.id).filter(job => job.status === "FAILED" && job.errorCategory !== "loop" && job.analysis && nextEscalationRoute(job.analysis.model, job.execution?.reasoning ?? job.analysis.reasoning) && (job.order ?? Number.MAX_SAFE_INTEGER) < lastOrder && !retried.has(job.id));
          for (const failed of failures) {
            retried.add(failed.id);
            try { this.queue.scheduleAutomaticRetry(failed.id, completed.tasks[0]?.description ?? "a later task"); await this.runWithEscalation(failed); }
            catch (error) { const retry = this.queue.get(failed.id); if (retry && retry.status !== "SUCCESS" && retry.status !== "SESSION_PAUSED") this.queue.transition(failed.id, "FAILED", { error: messageOf(error), errorCategory: this.executionErrorCategory }); }
          }
        } catch (error) {
          const latest = this.queue.get(current.id);
          if (latest && latest.status !== "SUCCESS" && latest.status !== "SESSION_PAUSED") this.queue.transition(current.id, "FAILED", { error: messageOf(error), errorCategory: latest.errorCategory ?? this.executionErrorCategory });
          if (this.humanReviewEnabled(first.projectId)) {
            this.queue.update(current.id, { awaitingHumanReview: true });
            break;
          }
          if (latest?.status === "SESSION_PAUSED") break;
          if (current.kind === "linter_setup") break;
          logJevError(`[${this.provider.id}:${current.id.slice(0, 8)}] Ticket failed: ${messageOf(error)}. Continuing pending tickets.`);
        }
      }
    } finally { this.runningProjects.delete(first.projectId); }
  }

  async run(id: string): Promise<Job> {
    const job = this.queue.get(id);
    if (!job) throw new Error("Job not found");
    if (this.isProjectRunning(job.projectId)) throw new Error(`A ${this.provider.label} execution is already running for this project`);
    if (this.needsHumanReview(job.projectId)) throw new Error("Approve the previous ticket before continuing");
    this.runningProjects.add(job.projectId);
    try {
      const setup = ensureProjectLinterTicket(this.queue, job.projectId, job.projectPath);
      if (setup && setup.id !== job.id) {
        if (setup.status === "FAILED") this.queue.moveManually(setup.id, "PENDING");
        if (setup.status === "SESSION_PAUSED") throw new Error("Wait for the project linter setup session to become available");
        let prepared: Job;
        try { prepared = await this.runWithEscalation(this.queue.get(setup.id)!); }
        catch (error) {
          const latest = this.queue.get(setup.id)!;
          prepared = latest.status === "SESSION_PAUSED" ? latest : this.queue.transition(setup.id, "FAILED", { error: messageOf(error), errorCategory: latest.errorCategory ?? this.executionErrorCategory })!;
        }
        if (this.humanReviewEnabled(job.projectId) && prepared.status !== "SESSION_PAUSED") this.queue.update(prepared.id, { awaitingHumanReview: true });
        if (prepared.status !== "SUCCESS" || this.needsHumanReview(job.projectId)) return this.queue.get(prepared.id)!;
      }
      const completed = await this.runWithEscalation(job);
      if (this.humanReviewEnabled(job.projectId) && completed.status !== "SESSION_PAUSED") this.queue.update(job.id, { awaitingHumanReview: true });
      return this.queue.get(job.id)!;
    } catch (error) {
      if (this.humanReviewEnabled(job.projectId)) this.queue.update(job.id, { awaitingHumanReview: true });
      throw error;
    }
    finally { this.runningProjects.delete(job.projectId); }
  }

  private async runWithEscalation(input: Job): Promise<Job> {
    this.runningTickets.add(input.id);
    try {
      await this.trackJevUsage(input, () => this.runTrackedWithEscalation(input));
      return this.queue.get(input.id)!;
    } finally { this.runningTickets.delete(input.id); }
  }

  private async runTrackedWithEscalation(input: Job): Promise<Job> {
    let current = this.queue.get(input.id) ?? input;
    const autoGit = this.autoGitEnabled(current.projectId);
    const resumed = current.gitDelivery?.status === "pending" && current.gitDelivery.branch !== undefined && current.gitDelivery.startHead !== undefined ? { branch: current.gitDelivery.branch, head: current.gitDelivery.startHead } : undefined;
    let gitStart = resumed;
    if (autoGit && !gitStart) {
      try { gitStart = prepareGitDelivery(current.projectPath); }
      catch (error) {
        this.queue.update(current.id, { gitDelivery: { status: "failed", error: messageOf(error) } });
        throw error;
      }
    }
    if (!autoGit) gitStart = undefined;
    if (gitStart && !resumed) this.queue.update(current.id, { gitDelivery: { status: "pending", branch: gitStart.branch, startHead: gitStart.head } });
    let continuations = 0;
    while (true) {
      let completed: Job;
      try {
        completed = await this.runTask(current);
      } catch (error) {
        const latest = this.queue.get(current.id);
        if (!latest?.analysis) throw error;
        completed = this.continueTask(latest, `${this.provider.label} attempt could not finish: ${messageOf(error)}`);
      }
      if (completed.status === "RUNNING" && completed.execution?.continuationPending) {
        // Keep the project slot and space retries without limiting their number.
        await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** Math.min(continuations++, 5))));
        current = this.queue.get(completed.id)!;
        continue;
      }
      continuations = 0;
      if (completed.status === "SUCCESS" && gitStart) {
        const message = commitMessageFromOutput(completed.output ?? "", completed.tasks[0]?.description ?? "Complete JEV ticket");
        try {
          const delivery = deliverGitTicket(completed.projectPath, gitStart, message);
          const at = new Date().toISOString();
          return this.queue.update(completed.id, { gitDelivery: delivery, execution: completed.execution ? { ...completed.execution, events: [...completed.execution.events, { id: randomUUID(), timestamp: at, kind: "system", title: "Ticket committed locally", detail: `${delivery.commit} · ${delivery.branch} · ${delivery.message}`, status: "success" }] } : undefined })!;
        } catch (error) {
          const detail = messageOf(error);
          const at = new Date().toISOString();
          return this.queue.update(completed.id, { gitDelivery: { status: "failed", branch: gitStart.branch, error: detail }, execution: completed.execution ? { ...completed.execution, events: [...completed.execution.events, { id: randomUUID(), timestamp: at, kind: "error", title: "Automatic Git commit failed", detail, status: "error" }] } : undefined })!;
        }
      }
      if (completed.status !== "FAILED" || !completed.analysis || completed.errorCategory === "loop") return completed;
      const previousReasoning = completed.execution?.reasoning ?? completed.analysis.reasoning;
      const next = nextEscalationRoute(completed.analysis.model, previousReasoning);
      if (!next) {
        if (completed.execution?.escalationPending) return this.queue.update(completed.id, { execution: { ...completed.execution, escalationPending: false } })!;
        return completed;
      }

      const previousModel = this.provider.modelId(completed.analysis.model);
      const nextModel = this.provider.modelId(next.model);
      const at = new Date().toISOString();
      const detail = `The ${previousModel} ${previousReasoning} attempt failed. JEV will retry with ${nextModel} ${next.reasoning}.`;
      logJevApplied(`${previousModel} ${previousReasoning} → ${nextModel} ${next.reasoning}`, `[${this.provider.id}:${completed.id.slice(0, 8)}] automatic ticket escalation`);
      current = this.queue.transition(completed.id, "ESCALATING", {
        analysis: { ...completed.analysis, ...next, rationale: [...completed.analysis.rationale, `Automatic escalation after ${previousModel} ${previousReasoning} failed; next route is ${nextModel} ${next.reasoning}.`] },
        error: undefined,
        errorCategory: undefined,
        recoveryNote: undefined,
        execution: completed.execution ? {
          ...completed.execution,
          phase: "QUEUED",
          model: nextModel,
          reasoning: next.reasoning,
          pid: undefined,
          completedAt: undefined,
          escalationPending: true,
          lastActivityAt: at,
          events: [...completed.execution.events, { id: randomUUID(), timestamp: at, kind: "system", title: "Ticket escalation started", detail, status: "active" }]
        } : undefined
      })!;
    }
  }

  /** Keeps unfinished work running at its selected route and records the next continuation. */
  private continueTask(job: Job, detail: string, patch: Partial<Job> = {}): Job {
    const now = new Date().toISOString();
    const execution: NonNullable<Job["execution"]> = patch.execution ?? job.execution ?? {
      phase: "QUEUED", model: this.provider.modelId(job.analysis!.model), reasoning: job.analysis!.reasoning, providerId: this.provider.id, providerName: this.provider.label,
      startedAt: now, lastActivityAt: now, verification: "not_run", events: []
    };
    return this.queue.transition(job.id, "RUNNING", {
      ...patch, error: undefined, errorCategory: undefined, recoveryNote: detail,
      execution: {
        ...execution, phase: "QUEUED", continuationPending: true, pid: undefined,
        completedAt: undefined, lastActivityAt: now,
        events: [...execution.events, { id: randomUUID(), timestamp: now, kind: "system", title: `${this.provider.label} continuation scheduled`, detail, status: "active" } satisfies ExecutionEvent].slice(-250)
      }
    })!;
  }

  private get executionErrorCategory(): "codex" | "agent" { return this.provider.id === "codex" ? "codex" : "agent"; }

  private async runTask(input: Job): Promise<Job> {
    const current = this.queue.get(input.id);
    if (!current) throw new Error("Job not found");
    if (current.status !== "PENDING" && current.status !== "ESCALATING" && !(current.status === "RUNNING" && current.execution?.continuationPending)) throw new Error(`Only pending or continuing jobs can run (${current.status})`);
    const first = current.analysis ? current : (await this.prepare(current))!;
    const model = first.analysis!.model;
    const modelId = await this.provider.resolveModel(model);
    const reasoning = first.analysis!.reasoning;
    const sameProvider = (first.execution?.providerId ?? "codex") === this.provider.id;
    const pausedThread = sameProvider && first.execution?.events.some(event => event.title === `${this.provider.label} session limit reached`) ? first.execution.threadId : undefined;
    const escalationThread = sameProvider && first.execution?.escalationPending ? first.execution.threadId : undefined;
    const continuingEscalation = current.status === "ESCALATING" || Boolean(first.execution?.escalationPending);
    const continuingWork = sameProvider && Boolean(first.execution?.continuationPending);
    const preserveExecution = sameProvider && (continuingEscalation || continuingWork || Boolean(pausedThread));
    const previousExecution = preserveExecution ? first.execution : undefined;
    const history = this.queue.list(first.projectId).filter(job => (job.execution?.providerId ?? "codex") === this.provider.id);
    const context = this.provider.createContext(first.projectId, first.projectPath, history.flatMap(job => job.execution?.threadId ? [job.execution.threadId] : []));
    const blockedThreads = new Set(history.filter(job => (job.execution?.implementationBlocked ?? this.provider.implementationBlocked(job.output ?? "")) || job.error?.startsWith("No project file changes were detected")).map(job => job.execution?.threadId).filter(Boolean));
    const previous = history.filter(job => job.id !== first.id && job.status === "SUCCESS" && job.execution?.threadId && !job.execution.threadArchivedAt && !job.execution.threadResumeDisabledAt && !blockedThreads.has(job.execution.threadId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    let resumeThread = this.provider.capabilities.resume ? pausedThread && !blockedThreads.has(pausedThread) ? pausedThread : escalationThread ?? (continuingWork ? first.execution?.threadId : previous?.execution?.threadId) : undefined;
    if (!pausedThread && !escalationThread && !continuingWork && previous && resumeThread) {
      let continuity = previous.execution?.reviewedNextTaskId === first.id && previous.execution.reviewedNextTasks === JSON.stringify(first.tasks) ? previous.execution.reviewedNextContinuity ?? "uncertain" : undefined;
      if (!continuity) {
        try { continuity = await this.taskContinuity([previous], first); }
        catch (error) { continuity = "uncertain"; logJevError(`[${this.provider.id}:${first.id.slice(0, 8)}] Thread continuity review unavailable: ${messageOf(error)}. Keeping the current thread.`); }
      }
      if (continuity === "unrelated") {
        const detail = `JEV found no task dependency between completed work and ticket ${first.id.slice(0, 8)}; this ticket starts a fresh ${this.provider.label} conversation.`;
        logJev(`[${this.provider.id}:${first.id.slice(0, 8)}] /clear START thread ${resumeThread}`);
        this.queue.appendProjectThreadEvent(first.projectId, resumeThread, `${this.provider.label} /clear started`, detail, "active", this.provider.id);
        try {
          if (this.provider.capabilities.archive) await this.provider.archiveThread(resumeThread, context);
          this.queue.clearProjectThread(first.projectId, resumeThread, detail, this.provider.label, this.provider.id);
          logJev(`[${this.provider.id}:${first.id.slice(0, 8)}] /clear COMPLETED`);
        } catch (error) {
          this.queue.disableProjectThreadResume(first.projectId, resumeThread, this.provider.id);
          this.queue.appendProjectThreadEvent(first.projectId, resumeThread, "Automatic clear failed", messageOf(error), "error", this.provider.id);
          logJevError(`[${this.provider.id}:${first.id.slice(0, 8)}] /clear FAILED: ${messageOf(error)}. Starting a fresh thread anyway.`);
        }
        resumeThread = undefined;
      }
    }
    const prompt = buildExecutionPrompt(first.tasks, first.analysis!, first.attachments, first.skills);
    const projectBefore = snapshotProject(first.projectPath);
    const startedAt = new Date().toISOString();
    const estimate = estimateExecutionTokens(prompt, first, reasoning, this.queue.list(first.projectId));
    const previousMetrics = previousExecution?.metrics;
    let activeRouteIndex = previousMetrics?.routes.length ?? 0;
    const attemptNumber = first.attempts + 1;
    this.queue.transition(first.id, current.status === "ESCALATING" ? "ESCALATING" : "RUNNING", {
      attempts: attemptNumber, output: preserveExecution ? first.output ?? "" : "", error: undefined, errorCategory: undefined, recoveryNote: undefined,
      execution: {
        ...previousExecution, providerId: this.provider.id, providerName: this.provider.label,
        implementationBlocked: false, phase: "STARTING", model: modelId, reasoning, startedAt: previousExecution?.startedAt ?? startedAt,
        lastActivityAt: startedAt, heartbeatAt: startedAt, pid: undefined, completedAt: undefined,
        escalationPending: continuingEscalation, continuationPending: continuingWork,
        projectChangesDetected: previousExecution?.projectChangesDetected ?? false, verification: "not_run", verificationNote: undefined,
        metrics: { estimatedTokens: (previousMetrics?.estimatedTokens ?? 0) + estimate.tokens, estimateBasis: previousMetrics?.estimateBasis ?? estimate.basis, actualTokens: previousMetrics?.actualTokens, turns: (previousMetrics?.turns ?? 0) + 1, routes: [...(previousMetrics?.routes ?? []), { stage: "implementation", model: modelId, reasoning }] },
        events: [...(previousExecution?.events ?? []), { id: randomUUID(), timestamp: startedAt, kind: "system", title: `Starting ${this.provider.label}`, detail: first.projectPath, status: "active" }]
      }
    });
    const tag = first.id.slice(0, 8);
    const heartbeat = setInterval(() => {
      this.refreshJevUsage(first.id);
      this.updateTicketExecution(first, execution => ({ ...execution, heartbeatAt: new Date().toISOString() }));
    }, 10_000);
    heartbeat.unref();
    const resumePrompt = pausedThread
      ? `${prompt}\n\nContinue the interrupted ticket in this thread. Review the work already made and finish the task. Use your judgment about any checks needed to verify the final result.`
      : continuingEscalation || continuingWork
        ? `${prompt}\n\nContinue this same ticket after a previous attempt. Inspect the work already made, correct what remains incomplete, and finish the requested task. Use your judgment about any checks needed to verify the final result.` : prompt;
    const outputHeader = preserveExecution ? `\n\n--- JEV ${pausedThread ? "session resume" : continuingWork ? "continuation attempt" : "escalation attempt"} ${attemptNumber} · ${modelId} / ${reasoning} ---\n` : "";
    let rawOutput = `${preserveExecution ? first.output ?? "" : ""}${outputHeader}`.slice(-250_000);
    let usage: ExecutionUsage | undefined = previousExecution?.usage;
    let verification = "not_run" as Verification;
    const record = (update: ExecutionUpdate) => {
      const now = new Date().toISOString();
      if (update.usage) usage = Object.fromEntries(["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"].map(key => [key, ((usage as Record<string, number> | undefined)?.[key] ?? 0) + ((update.usage as Record<string, number>)[key] ?? 0)]));
      if (update.verification === "functional_verified" || update.verification === "tests_passed" && verification !== "functional_verified" || update.verification === "build_only" && verification === "not_run") verification = update.verification;
      this.updateTicketExecution(first, execution => ({
        ...execution, phase: update.phase, lastActivityAt: now, threadId: update.threadId ?? execution.threadId,
        metrics: update.usage && execution.metrics ? { ...execution.metrics, routes: execution.metrics.routes.map((route, index) => index === activeRouteIndex ? { ...route, usage: update.usage } : route) } : execution.metrics,
        events: update.event ? [...execution.events, { ...update.event, id: randomUUID(), timestamp: now }].slice(-250) : execution.events
      }));
    };
    const executeTurn = async (turnModel: string, effort: Reasoning, instruction: string, threadId?: string, initial = false): Promise<ExecutionResult> => {
      if (first.attachments?.length && !this.provider.capabilities.images) return { success: false, error: `${this.provider.label} does not support image attachments.`, implementationBlocked: true, quotaReached: false };
      try {
        return await this.provider.run({ context, threadId: this.provider.capabilities.resume ? threadId : undefined, model: turnModel, reasoning: effort, prompt: instruction, attachments: first.attachments ?? [], taskDescription: first.tasks.map(task => task.description).join(" "), logTag: tag }, {
          onStart: ({ pid, command }) => {
            const at = new Date().toISOString();
            logJevApplied(effort.toUpperCase(), `[${this.provider.id}:${tag}] ${turnModel}`);
            process.stdout.write(`[${this.provider.id}:${tag}] EXEC ${command}\n`);
            this.updateTicketExecution(first, execution => ({ ...execution, pid, lastActivityAt: at, events: initial ? [...execution.events,
              { id: randomUUID(), timestamp: at, kind: "system", title: "JEV route applied", detail: `Model used: ${turnModel} · reasoning used: ${effort}`, status: "success" },
              ...(first.attachments?.length ? [{ id: randomUUID(), timestamp: at, kind: "system" as const, title: "Visual references attached", detail: `${first.attachments.length} images sent to ${this.provider.label}.`, status: "success" as const }] : []),
              { id: randomUUID(), timestamp: at, kind: "command", title: `${this.provider.label} command launched`, detail: command, status: "success" }
            ] : execution.events }));
          },
          onOutput: line => { rawOutput = `${rawOutput}${line}\n`.slice(-250_000); this.updateTicketOutput(first, rawOutput); },
          onUpdate: record
        });
      } catch (error) { return { success: false, error: `${this.provider.label} execution unavailable: ${messageOf(error)}`, implementationBlocked: false, quotaReached: false }; }
    };
    try {
      let outcome = await executeTurn(modelId, reasoning, resumePrompt, resumeThread, true);
      while (outcome.success && outcome.requestedRoute) {
        const route = outcome.requestedRoute;
        const threadId = this.queue.get(first.id)?.execution?.threadId;
        if (this.provider.capabilities.resume && !threadId) { outcome = { success: false, error: `${this.provider.label} did not provide a thread ID for continuation`, implementationBlocked: false, quotaReached: false }; break; }
        const requestedModel = await this.provider.resolveModel(route.model);
        if (requestedModel !== modelId) logJev(`[${this.provider.id}:${tag}] Keeping ${modelId}; JEV uses one model for the whole ticket.`);
        const effort = route.reasoning === "low" ? reasoningAt(0) : clampModelReasoning(model, route.reasoning);
        activeRouteIndex += 1;
        const at = new Date().toISOString();
        this.updateTicketExecution(first, execution => ({ ...execution, reasoning: effort, lastActivityAt: at, metrics: execution.metrics ? { ...execution.metrics, turns: execution.metrics.turns + 1, routes: [...execution.metrics.routes, { stage: "implementation", model: modelId, reasoning: effort }] } : execution.metrics, events: [...execution.events, { id: randomUUID(), timestamp: at, kind: "system", title: `${this.provider.label} reasoning changed`, detail: `implementation: ${modelId} · ${effort} reasoning`, status: "active" } satisfies ExecutionEvent].slice(-250) }));
        outcome = await executeTurn(modelId, effort, `Continue and finish the requested task. Keep model ${model} and vary only reasoning effort within its policy range. Inspect the project files needed to complete the task, including relevant implementation and direct dependencies. Use your judgment about running tests, builds, type checks, or other checks that would verify the result, and report the checks actually run. If a different reasoning effort is needed for a further implementation turn, end your final message with JEV_ROUTE=${model}:<effort>. Otherwise complete the task.`, threadId);
      }
      let success = outcome.success;
      let failureMessage = outcome.error ?? `${this.provider.label} execution did not complete`;
      const projectChangesDetected = Boolean(previousExecution?.projectChangesDetected || changedProjectFiles(projectBefore, snapshotProject(first.projectPath)).length);
      const expectsProjectChanges = first.analysis!.task_types.some(type => type !== "research" && type !== "architecture");
      const linterSetupMissing = success && first.kind === "linter_setup" && missingProjectLinters(first.projectPath, first.linterLanguages).length > 0;
      if (linterSetupMissing) { success = false; failureMessage = "Project linter setup is still missing. Review execution output before retrying."; }
      if (success && first.kind !== "linter_setup" && expectsProjectChanges && !projectChangesDetected) {
        success = false; failureMessage = "No project file changes were detected for this implementation task.";
        logJev(`[${this.provider.id}:${tag}] ${failureMessage} Continuing the ticket.`);
      }
      if (outcome.quotaReached) {
        const limit = await this.provider.readRateLimit().catch((error) => ({ available: false, reached: false, resetsAt: undefined, unavailableReason: messageOf(error) }));
        const resetAt = [limit.resetsAt, outcome.retryAt].filter((value): value is string => Boolean(value)).sort().at(-1);
        const resumeAt = new Date(Math.max(Date.now(), resetAt ? Date.parse(resetAt) : Date.now()) + 60_000).toISOString();
        logSession(`[${this.provider.id}:${tag}] Session Paused; reset ${resetAt ?? "unknown"}, automatic resume at ${resumeAt}.`);
        this.queue.pauseForSessionLimit(first.id, resumeAt, this.provider.label);
        this.updateTicketExecution(first, execution => ({ ...execution, projectChangesDetected, usage }));
        return this.queue.update(first.id, { output: rawOutput })!;
      }
      if (!success && !outcome.implementationBlocked && !linterSetupMissing) {
        const latest = this.queue.get(first.id)!;
        return this.continueTask(latest, `${failureMessage} Continuing the same ticket.`, { output: rawOutput, execution: { ...latest.execution!, usage, verification, projectChangesDetected } });
      }
      const now = new Date().toISOString();
      const representative = this.queue.get(first.id)!; let compactedAfterTask = false; let compactionError: string | undefined; let clearError: string | undefined;
      let statusSnapshot = await this.provider.readStatus(representative.execution?.threadId, context).catch(error => ({ capturedAt: new Date().toISOString(), unavailableReason: messageOf(error) })) as ExecutionStatusSnapshot;
      let reviewedNextTaskId: string | undefined;
      let reviewedNextTasks: string | undefined;
      let reviewedNextContinuity: "related" | "unrelated" | "uncertain" | undefined;
      if (representative.execution?.threadId) {
        const ordered = this.queue.listProjectExecutionOrder(first.projectId);
        const lastIndex = ordered.findIndex(candidate => candidate.id === first.id);
        const next = success ? ordered.slice(lastIndex + 1).find(job => job.status === "PENDING") ?? ordered.find(job => job.status === "PENDING") : undefined;
        let continuity: "related" | "unrelated" | "uncertain" = "uncertain";
        if (next) {
          try { continuity = await this.taskContinuity([first], next); }
          catch (error) { logJevError(`[${this.provider.id}:${tag}] Thread continuity review unavailable: ${messageOf(error)}. Keeping the current thread.`); }
          reviewedNextTaskId = next.id;
          reviewedNextTasks = JSON.stringify(next.tasks);
          reviewedNextContinuity = continuity;
        }
        if (success && continuity === "unrelated") {
          const detail = `JEV found no task dependency between completed work and next ticket ${next!.id.slice(0, 8)}; the next task starts a fresh ${this.provider.label} conversation.`;
          logJev(`[${this.provider.id}:${tag}] /clear START thread ${representative.execution.threadId}`);
          this.updateTicketExecution(first, execution => ({ ...execution, events: [...execution.events, { id: randomUUID(), timestamp: new Date().toISOString(), kind: "system", title: `${this.provider.label} /clear started`, detail, status: "active" }] }));
          try { if (this.provider.capabilities.archive) await this.provider.archiveThread(representative.execution.threadId, context); this.queue.clearProjectThread(first.projectId, representative.execution.threadId, detail, this.provider.label, this.provider.id); logJev(`[${this.provider.id}:${tag}] /clear COMPLETED`); }
          catch (error) { clearError = messageOf(error); this.queue.disableProjectThreadResume(first.projectId, representative.execution.threadId, this.provider.id); logJevError(`[${this.provider.id}:${tag}] /clear FAILED: ${clearError}. The next ticket will start a fresh thread.`); }
        }
        if (success && this.provider.capabilities.compaction && next && continuity !== "unrelated" && (statusSnapshot.context?.usedTokens ?? 0) >= AUTO_COMPACTION_CONTEXT_TOKENS) {
          const reason = `Context reached ${statusSnapshot.context!.usedTokens.toLocaleString("en-US")} tokens (automatic threshold: ${AUTO_COMPACTION_CONTEXT_TOKENS.toLocaleString("en-US")}).`;
          logJev(`[${this.provider.id}:${tag}] /compact START thread ${representative.execution.threadId}`);
          this.updateTicketExecution(first, execution => ({ ...execution, lastActivityAt: now, events: [...execution.events, { id: randomUUID(), timestamp: now, kind: "system", title: `${this.provider.label} /compact started`, detail: `Thread ${representative.execution!.threadId} — ${reason}`, status: "active" }] }));
          try { await this.provider.compactThread(representative.execution.threadId, context); compactedAfterTask = true; statusSnapshot = await this.provider.readStatus(representative.execution.threadId, context).catch(() => statusSnapshot); }
          catch (error) { compactionError = messageOf(error); }
        }
      }
      const accountUsage = await this.provider.readAccountUsage().catch(error => ({ capturedAt: new Date().toISOString(), unavailableReason: messageOf(error) }));
      if (compactedAfterTask) logJev(`[${this.provider.id}:${tag}] /compact COMPLETED`);
      if (compactionError) logJevError(`[${this.provider.id}:${tag}] /compact FAILED: ${compactionError}`);
      const latest = this.queue.get(first.id)!;
      const checkpoint: ExecutionEvent = { id: randomUUID(), timestamp: now, kind: "system", title: `${this.provider.label} status checkpoint`, detail: JSON.stringify({ model: latest.execution?.model, reasoning: latest.execution?.reasoning, taskUsage: usage, accountUsage, codexStatus: statusSnapshot, verification }), status: "success" };
      const compactEvents: ExecutionEvent[] = compactedAfterTask ? [{ id: randomUUID(), timestamp: now, kind: "system", title: `${this.provider.label} /compact confirmed`, detail: `${this.provider.label} confirmed JEV's automatic compaction.`, status: "success" }] : compactionError ? [{ id: randomUUID(), timestamp: now, kind: "error", title: "Automatic compaction failed", detail: compactionError, status: "error" }] : [];
      if (clearError) compactEvents.push({ id: randomUUID(), timestamp: now, kind: "error", title: "Automatic clear failed", detail: clearError, status: "error" });
      const completed = this.queue.transition(first.id, success ? "SUCCESS" : "FAILED", { output: rawOutput, error: success ? undefined : failureMessage, errorCategory: success ? undefined : (outcome.implementationBlocked ? "code" : this.executionErrorCategory), execution: { ...latest.execution!, phase: success ? "COMPLETED" : "ERROR", escalationPending: false, continuationPending: false, projectChangesDetected, lastActivityAt: now, completedAt: now, usage, accountUsage, codexStatus: statusSnapshot, metrics: latest.execution!.metrics ? { ...latest.execution!.metrics, actualTokens: totalExecutionTokens(usage) } : latest.execution!.metrics, verification, implementationBlocked: outcome.implementationBlocked, compactedAfterTask, reviewedNextTaskId, reviewedNextTasks, reviewedNextContinuity, events: [...latest.execution!.events, checkpoint, ...compactEvents, { id: randomUUID(), timestamp: now, kind: success ? "system" : "error", title: success ? "Execution completed" : "Execution failed", detail: success ? (verification === "functional_verified" ? `${this.provider.label} finished with functional verification.` : verification === "tests_passed" ? `${this.provider.label} finished and automated tests passed.` : verification === "build_only" ? `${this.provider.label} finished; compilation passed but functional behavior was not verified.` : `${this.provider.label} finished without a detected verification command.`) : failureMessage, status: success ? "success" : "error" }] } })!;
      if (success) process.stdout.write(`\x1b[38;5;24m[${this.provider.id}:${tag}] Ticket ${first.tasks[0]?.description ?? first.id} — development completed\x1b[0m\n`);
      return completed;
    } catch (error) {
      const latest = this.queue.get(first.id)!;
      const now = new Date().toISOString();
      return this.queue.transition(first.id, "FAILED", {
        output: rawOutput, error: messageOf(error), errorCategory: this.executionErrorCategory,
        execution: { ...latest.execution!, phase: "ERROR", completedAt: now, lastActivityAt: now, escalationPending: false, events: [...latest.execution!.events, { id: randomUUID(), timestamp: now, kind: "error", title: "Execution finalization failed", detail: messageOf(error), status: "error" }] }
      })!;
    } finally { clearInterval(heartbeat); }
  }
  private updateTicketExecution(job: Job, mutate: (execution: NonNullable<Job["execution"]>) => NonNullable<Job["execution"]>) { const current = this.queue.get(job.id); if (current?.execution) this.queue.update(job.id, { execution: mutate(current.execution) }, true); }
  private updateTicketOutput(job: Job, output: string) { this.queue.update(job.id, { output }, true); }
}
