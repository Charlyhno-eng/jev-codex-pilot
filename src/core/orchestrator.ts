import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { clampModelReasoning, codexModelId, MODEL_LEVELS, nextEscalationRoute, REASONING_LEVELS, reasoningAt, reasoningIndex } from "./codex-models.js";
import { activeCodexModelId } from "./codex-catalog.js";
import { readCodexStatusSnapshot } from "./codex-status.js";
import { CodexLoopDetector } from "./codex-loop-detector.js";
import { codexExecPrefix, implementationBlocked } from "./codex-execution.js";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { analyze, assessTaskContinuity } from "./analyzer.js";
import { logJev, logJevApplied, logJevError, logSession } from "./jev-logger.js";
import { buildCodexCommand, buildCodexPrompt } from "./prompt.js";
import { changedProjectFiles, snapshotProject } from "./project-snapshot.js";
import { codexHookArgs } from "./hooks/codex-config.js";
import type { JobQueue } from "./queue.js";
import type { CodexAccountUsage, CodexModel, CodexStatusSnapshot, CodexUsage, ExecutionEvent, ExecutionPhase, Job, Reasoning } from "./types.js";

type JsonEvent = Record<string, unknown> & { type?: string; item?: Record<string, unknown> };
type Verification = "not_run" | "build_only" | "tests_passed" | "functional_verified" | "environment_blocked";
type CodexRateLimit = { available: boolean; reached: boolean; resetsAt?: string; unavailableReason?: string };
const AUTO_COMPACTION_CONTEXT_TOKENS = 100_000;
function totalCodexTokens(usage?: CodexUsage) {
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
    .map(job => job.execution?.metrics ? { ...job.execution.metrics, actualTokens: totalCodexTokens(job.execution.usage) ?? job.execution.metrics.actualTokens } : undefined)
    .filter((metrics): metrics is NonNullable<typeof metrics> => Boolean(metrics?.actualTokens && metrics.estimatedTokens))
    .slice(0, 12);
  if (!comparable.length) return { tokens: scopeEstimate, basis: "scope" as const };
  const priorActual = median(comparable.map(metrics => metrics.actualTokens!));
  const priorScope = median(comparable.map(metrics => metrics.estimatedTokens));
  const calibrated = Math.round(priorActual * Math.max(.5, Math.min(2, scopeEstimate / Math.max(1, priorScope))) / 100) * 100;
  return { tokens: Math.max(scopeEstimate, calibrated), basis: "project_history" as const };
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 4000);
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value).slice(0, 4000);
}
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
function sessionLimitReported(output: string) { return /(?:5[- ]?hour|session|usage|rate)[_ -]?(?:limit|quota).{0,100}(?:reached|exceeded)|(?:reached|exceeded|hit|exhausted).{0,100}(?:5[- ]?hour|session|usage|rate)[_ -]?(?:limit|quota)|rate_limit_exceeded/i.test(output); }

function retryTimeReported(output: string) {
  const match = output.match(/try again at\s+([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/i);
  if (!match) return undefined;
  const parsed = Date.parse(match[1].replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1"));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/** Detects whether a Codex compaction event completed. */
export function isCompactionComplete(message: Record<string, unknown>) {
  const item = (message.params as { item?: { type?: unknown } } | undefined)?.item;
  return (message.method === "item/completed" || message.method === "item.completed") && item?.type === "contextCompaction";
}

function isCompactionFailure(message: Record<string, unknown>) {
  const turn = (message.params as { turn?: { status?: unknown } } | undefined)?.turn;
  return (message.method === "turn/completed" || message.method === "turn.completed") && turn?.status === "failed";
}

function describe(event: JsonEvent): { phase: ExecutionPhase; item?: Omit<ExecutionEvent, "id" | "timestamp">; threadId?: string } {
  const type = event.type ?? "event";
  const item = event.item ?? {};
  const itemType = String(item.type ?? "");
  if (type === "thread.started") return { phase: "STARTING", threadId: text(event.thread_id), item: { kind: "system", title: "Codex session started", status: "success" } };
  if (type === "turn.started") return { phase: "THINKING", item: { kind: "reasoning", title: "Reading the project and planning the work", status: "active" } };
  if (type === "turn.completed") return { phase: "FINISHING", item: { kind: "system", title: "Codex finished its turn", detail: text(event.usage), status: "success" } };
  if (type === "turn.failed" || type === "error") return { phase: "ERROR", item: { kind: "error", title: "Codex reported an error", detail: text(event.error ?? event.message), status: "error" } };
  if (type === "item.started" && itemType === "command_execution") return { phase: "WORKING", item: { kind: "command", title: "Running a command", detail: text(item.command), status: "active" } };
  if (type === "item.completed" && itemType === "command_execution") {
    const failed = typeof item.exit_code === "number" && item.exit_code !== 0;
    return { phase: "WORKING", item: { kind: "command", title: failed ? "Command failed" : "Command completed", detail: text(item.command ?? item.aggregated_output), status: failed ? "error" : "success" } };
  }
  if (type === "item.completed" && /file|change|patch/i.test(itemType)) return { phase: "WORKING", item: { kind: "file", title: "Project files updated", detail: text(item.path ?? item.changes ?? item), status: "success" } };
  if (type === "item.completed" && itemType === "agent_message") return { phase: "WORKING", item: { kind: "message", title: "Codex update", detail: text(item.text), status: "success" } };
  if (type === "item.completed" && /reason/i.test(itemType)) return { phase: "THINKING", item: { kind: "reasoning", title: "Reasoning step completed", detail: text(item.text), status: "success" } };
  if (type === "item.started" && /mcp|tool/i.test(itemType)) return { phase: "WORKING", item: { kind: "command", title: "Calling a tool", detail: text(item.name ?? item.server), status: "active" } };
  if (type === "item.completed" && /mcp|tool/i.test(itemType)) return { phase: "WORKING", item: { kind: "command", title: "Tool call completed", detail: text(item.name ?? item.result), status: "success" } };
  if (type === "item.completed" && /web_search/i.test(itemType)) return { phase: "WORKING", item: { kind: "message", title: "Web search completed", detail: text(item.query), status: "success" } };
  if (type === "item.completed" && /todo/i.test(itemType)) return { phase: "WORKING", item: { kind: "message", title: "Work plan updated", detail: text(item.items ?? item), status: "success" } };
  if (type === "item.started" && /reason/i.test(itemType)) return { phase: "THINKING", item: { kind: "reasoning", title: "Codex is reasoning", status: "active" } };
  if (type === "raw") return { phase: "WORKING", item: { kind: "message", title: "Codex diagnostic", detail: text(event.message), status: "active" } };
  return { phase: "WORKING" };
}

function compactThread(threadId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", [...codexHookArgs(), "app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Codex compaction timed out after 5 minutes")), 300_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.kill(); error ? reject(error) : resolve(); };
    lines.on("line", line => {
      let message: Record<string, any>;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 0 && message.error) return finish(new Error(message.error.message ?? "Could not initialize Codex app server"));
      if (message.id === 0 && message.result) { send({ method: "initialized", params: {} }); send({ method: "thread/resume", id: 1, params: { threadId } }); }
      if (message.id === 1 && message.result?.thread) send({ method: "thread/compact/start", id: 2, params: { threadId } });
      if (message.id === 1 && message.error) return finish(new Error(message.error.message ?? "Could not resume Codex thread"));
      if (message.id === 2 && message.error) return finish(new Error(message.error.message ?? "Could not compact Codex thread"));
      if (isCompactionComplete(message)) finish();
      if (isCompactionFailure(message)) finish(new Error("Codex compaction failed"));
    });
    child.on("error", finish);
    child.on("close", code => { if (!settled) finish(code === 0 ? undefined : new Error(`Codex app server exited with code ${code}`)); });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "jev_codex_pilot", title: "JEV Codex Pilot", version: "0.2.0" } } });
  });
}

function archiveThread(threadId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Codex thread clear timed out")), 30_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.kill(); error ? reject(error) : resolve(); };
    lines.on("line", line => {
      let message: Record<string, any>;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 0 && message.error) return finish(new Error(message.error.message ?? "Could not initialize Codex app server"));
      if (message.id === 0 && message.result) { send({ method: "initialized", params: {} }); send({ method: "thread/archive", id: 1, params: { threadId } }); }
      if (message.id === 1 && message.error) return finish(new Error(message.error.message ?? "Could not clear Codex thread"));
      if (message.id === 1 && message.result) finish();
    });
    child.on("error", finish);
    child.on("close", code => { if (!settled) finish(code === 0 ? undefined : new Error(`Codex app server exited with code ${code}`)); });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "jev_codex_pilot", title: "JEV Codex Pilot", version: "0.2.0" } } });
  });
}

/** Writes a completed-ticket terminal message. */
function logTicketCompleted(tag: string, title: string) {
  process.stdout.write(`\x1b[38;5;24m[codex:${tag}] Ticket ${title} — development completed\x1b[0m\n`);
}

/** Resumes one Codex turn in the existing thread. */
function resumeCodexTurn(projectPath: string, threadId: string, modelId: string, reasoning: Reasoning, prompt: string, tag: string, record: (line: string) => void, onStart: (child: ReturnType<typeof spawn>) => void): Promise<{ code: number | null; error?: string }> {
  return new Promise(resolve => {
    const args = [...codexExecPrefix(true), "--json", "--skip-git-repo-check", "--model", modelId, "-c", `model_reasoning_effort=\"${reasoning}\"`, ...codexHookArgs(), threadId, prompt];
    const child = spawn("codex", args, { cwd: projectPath, shell: false, env: { ...process.env, JEV_HOOK_TASK: prompt.slice(0, 2_000) } });
    onStart(child);
    let buffer = ""; let settled = false;
    child.stdin.end();
    child.stdout.on("data", chunk => {
      const value = chunk.toString(); process.stdout.write(`[codex:${tag}] ${value}`);
      buffer += value;
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      lines.forEach(record);
    });
    child.stderr.on("data", chunk => { const value = chunk.toString(); process.stderr.write(`[codex:${tag}] ${value}`); record(value.trim()); });
    child.on("error", error => { if (settled) return; settled = true; resolve({ code: null, error: error.message }); });
    child.on("close", code => { if (settled) return; settled = true; if (buffer) record(buffer); resolve({ code }); });
  });
}

/** Best effort only: this is Codex-account usage, never an attribution to one job. */
function readCodexAccountUsage(): Promise<CodexAccountUsage> {
  return new Promise(resolve => {
    const capturedAt = new Date().toISOString();
    const child = spawn("codex", ["app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (snapshot: CodexAccountUsage) => { if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.kill(); resolve(snapshot); };
    const timer = setTimeout(() => finish({ capturedAt, unavailableReason: "Codex account usage timed out." }), 2_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const asNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
    lines.on("line", line => {
      let message: Record<string, any>;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 0 && message.error) return finish({ capturedAt, unavailableReason: message.error.message ?? "Codex account usage is unavailable." });
      if (message.id === 0 && message.result) { send({ method: "initialized", params: {} }); send({ method: "account/usage/read", id: 1, params: {} }); }
      if (message.id === 1 && message.error) return finish({ capturedAt, unavailableReason: message.error.message ?? "Codex account usage is unavailable." });
      if (message.id === 1 && message.result) {
        const summary = message.result.summary ?? {};
        const today = new Date().toISOString().slice(0, 10);
        const bucket = Array.isArray(message.result.dailyUsageBuckets) ? message.result.dailyUsageBuckets.find((entry: Record<string, unknown>) => entry.startDate === today) : undefined;
        finish({ capturedAt, lifetimeTokens: asNumber(summary.lifetimeTokens), peakDailyTokens: asNumber(summary.peakDailyTokens), todayTokens: asNumber(bucket?.tokens) });
      }
    });
    child.on("error", error => finish({ capturedAt, unavailableReason: messageOf(error) }));
    child.on("close", code => { if (!settled) finish({ capturedAt, unavailableReason: code === 0 ? "Codex account usage is not available for this authentication mode." : `Codex app-server exited with code ${code}.` }); });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "jev_codex_pilot", title: "JEV Codex Pilot", version: "0.2.0" } } });
  });
}

/** Reads the Codex session quota without inferring limits from token totals. */
function readCodexRateLimit(): Promise<CodexRateLimit> {
  return new Promise(resolve => {
    const child = spawn("codex", ["app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout }); let settled = false;
    const finish = (value: CodexRateLimit) => { if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.kill(); resolve(value); };
    const timer = setTimeout(() => finish({ available: false, reached: false, unavailableReason: "Codex rate-limit check timed out." }), 2_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const asDate = (value: unknown) => typeof value === "number" ? new Date(value * 1_000).toISOString() : undefined;
    lines.on("line", line => {
      let message: Record<string, any>; try { message = JSON.parse(line); } catch { return; }
      if (message.id === 0 && message.error) return finish({ available: false, reached: false, unavailableReason: message.error.message ?? "Codex rate limits are unavailable." });
      if (message.id === 0 && message.result) { send({ method: "initialized", params: {} }); send({ method: "account/rateLimits/read", id: 1, params: {} }); }
      if (message.id === 1 && message.error) return finish({ available: false, reached: false, unavailableReason: message.error.message ?? "Codex rate limits are unavailable." });
      if (message.id === 1 && message.result) {
        const values = Object.values(message.result.rateLimitsByLimitId ?? { codex: message.result.rateLimits ?? {} }) as Array<Record<string, any>>;
        const windows = values.flatMap(limit => [limit.primary, limit.secondary].filter(Boolean) as Array<Record<string, unknown>>);
        const reached = values.some(limit => Boolean(limit.rateLimitReachedType)) || windows.some(window => Number(window.usedPercent) >= 100);
        const reachedWindows = values.flatMap(limit => {
          const named = limit.rateLimitReachedType === "primary" ? limit.primary : limit.rateLimitReachedType === "secondary" ? limit.secondary : undefined;
          return named ? [named] : [limit.primary, limit.secondary].filter(window => Number(window?.usedPercent) >= 100);
        });
        const resets = (reachedWindows.length ? reachedWindows : windows).map(window => asDate(window.resetsAt)).filter((value): value is string => Boolean(value)).sort();
        finish({ available: true, reached, resetsAt: resets.at(-1) });
      }
    });
    child.on("error", error => finish({ available: false, reached: false, unavailableReason: messageOf(error) }));
    child.on("close", code => { if (!settled) finish({ available: false, reached: false, unavailableReason: code === 0 ? "Codex rate limits are unavailable for this authentication mode." : `Codex app-server exited with code ${code}.` }); });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "jev_codex_pilot", title: "JEV Codex Pilot", version: "0.2.0" } } });
  });
}

/** Prepares queued tickets and runs each task through Codex. */
export class Orchestrator {
  private runningProjects = new Set<string>();
  private continuityDecisions = new Map<string, "related" | "unrelated" | "uncertain">();
  constructor(private queue: JobQueue, private analyzer = analyze, private compactor: (threadId: string) => Promise<void> = compactThread, private accountUsageReader: () => Promise<CodexAccountUsage> = readCodexAccountUsage, private archiver: (threadId: string) => Promise<void> = archiveThread, private rateLimitReader: () => Promise<CodexRateLimit> = readCodexRateLimit, private statusReader: (threadId?: string) => Promise<CodexStatusSnapshot> = readCodexStatusSnapshot, private continuityReviewer: (completed: Job[], next: Job) => Promise<"related" | "unrelated" | "uncertain"> = assessTaskContinuity) {}

  async prepare(job: Job) {
    if (!existsSync(job.projectPath)) throw new Error(`Project not found: ${job.projectPath}`);
    if (job.analysis) return job;
    try {
      const analysis = await this.analyzer(job.projectPath, job.tasks);
      logJev(`JEV recommends ${codexModelId(analysis.model)} with ${analysis.reasoning} reasoning for task ${job.id.slice(0, 8)} · expected outcome clarity ${analysis.outcome_clarity_score ?? "unavailable"}% · complexity ${analysis.complexity}/5`);
      return this.queue.update(job.id, { analysis });
    } catch (error) {
      logJevError(`Recommendation unavailable for task ${job.id.slice(0, 8)} · ${messageOf(error)}`);
      this.queue.update(job.id, { error: messageOf(error), errorCategory: "jev" });
      throw error;
    }
  }

  isProjectRunning(projectId: string) { return this.runningProjects.has(projectId) || this.queue.list(projectId).some(job => job.status === "RUNNING" || job.status === "ESCALATING"); }
  ownsProjectRun(projectId: string) { return this.runningProjects.has(projectId); }

  private async taskContinuity(completed: Job[], next: Job) {
    const key = JSON.stringify({ completed: completed.map(job => [job.id, job.tasks]), next: [next.id, next.tasks] });
    const cached = this.continuityDecisions.get(key);
    if (cached) return cached;
    const decision = await this.continuityReviewer(completed, next);
    this.continuityDecisions.set(key, decision);
    if (this.continuityDecisions.size > 100) this.continuityDecisions.delete(this.continuityDecisions.keys().next().value!);
    return decision;
  }

  async resumeSessionPausedJobs() {
    const paused = this.queue.list().filter(job => job.status === "SESSION_PAUSED" && !this.isProjectRunning(job.projectId));
    if (!paused.length) return [];
    const now = Date.now();
    const scheduled = paused.filter(job => job.sessionResumeAt && Date.parse(job.sessionResumeAt) <= now);
    const unscheduled = paused.filter(job => !job.sessionResumeAt);
    let eligible = scheduled;
    if (unscheduled.length) {
      const limits = await this.rateLimitReader().catch(error => ({ available: false, reached: false, unavailableReason: messageOf(error) }));
      if (limits.available && !limits.reached) eligible = [...scheduled, ...unscheduled];
    }
    if (!eligible.length) return [];
    for (const job of eligible) this.queue.resumeSessionPaused(job.id);
    const eligibleIds = new Set(eligible.map(job => job.id));
    return [...new Set(eligible.map(job => job.projectId))]
      .map(projectId => this.queue.listProjectExecutionOrder(projectId).find(job => eligibleIds.has(job.id)))
      .filter((job): job is Job => Boolean(job));
  }

  async command(job: Job) { const prepared = job.analysis ? job : (await this.prepare(job))!; return buildCodexCommand(prepared.tasks, prepared.analysis!, await activeCodexModelId(prepared.analysis!.model)); }

  /** Drains the project's pending tickets in queue order, including arrivals during the run. */
  async runBatch(id: string): Promise<void> {
    const first = this.queue.get(id);
    if (!first) throw new Error("Job not found");
    if (this.isProjectRunning(first.projectId)) throw new Error("A Codex execution is already running for this project");
    this.runningProjects.add(first.projectId);
    try {
      const retried = new Set<string>();
      while (true) {
        const current = this.queue.listProjectExecutionOrder(first.projectId)
          .find(job => job.status === "PENDING" || job.status === "SESSION_PAUSED");
        if (!current || current.status === "SESSION_PAUSED") break;
        try {
          const completed = await this.runWithEscalation(current);
          if (completed.status === "SESSION_PAUSED") break;
          const lastOrder = completed.status === "SUCCESS" ? completed.order ?? Number.MAX_SAFE_INTEGER : -1;
          if (lastOrder < 0) continue;
          const failures = this.queue.listBatch(first.batchId ?? first.id).filter(job => job.status === "FAILED" && job.errorCategory !== "loop" && job.analysis && nextEscalationRoute(job.analysis.model, job.execution?.reasoning ?? job.analysis.reasoning) && (job.order ?? Number.MAX_SAFE_INTEGER) < lastOrder && !retried.has(job.id));
          for (const failed of failures) {
            retried.add(failed.id);
            try { this.queue.scheduleAutomaticRetry(failed.id, completed.tasks[0]?.description ?? "a later task"); await this.runWithEscalation(failed); }
            catch (error) { const retry = this.queue.get(failed.id); if (retry && retry.status !== "SUCCESS" && retry.status !== "SESSION_PAUSED") this.queue.transition(failed.id, "FAILED", { error: messageOf(error), errorCategory: "codex" }); }
          }
        } catch (error) {
          const latest = this.queue.get(current.id);
          if (latest && latest.status !== "SUCCESS" && latest.status !== "SESSION_PAUSED") this.queue.transition(current.id, "FAILED", { error: messageOf(error), errorCategory: "codex" });
        }
      }
    } finally { this.runningProjects.delete(first.projectId); }
  }

  async run(id: string): Promise<Job> {
    const job = this.queue.get(id);
    if (!job) throw new Error("Job not found");
    if (this.isProjectRunning(job.projectId)) throw new Error("A Codex execution is already running for this project");
    this.runningProjects.add(job.projectId);
    try { return await this.runWithEscalation(job); }
    finally { this.runningProjects.delete(job.projectId); }
  }

  private async runWithEscalation(input: Job): Promise<Job> {
    let current = this.queue.get(input.id) ?? input;
    while (true) {
      let completed: Job;
      try {
        completed = await this.runTask(current);
      } catch (error) {
        const latest = this.queue.get(current.id);
        if (!latest?.analysis) throw error;
        const at = new Date().toISOString();
        const detail = messageOf(error);
        completed = this.queue.transition(current.id, "FAILED", {
          error: detail,
          errorCategory: "codex",
          execution: latest.execution ? { ...latest.execution, phase: "ERROR", completedAt: at, escalationPending: false, events: [...latest.execution.events, { id: randomUUID(), timestamp: at, kind: "error", title: "Codex attempt failed to start", detail, status: "error" }] } : undefined
        })!;
      }
      if (completed.status !== "FAILED" || !completed.analysis || completed.errorCategory === "loop") return completed;
      const previousReasoning = completed.execution?.reasoning ?? completed.analysis.reasoning;
      const next = nextEscalationRoute(completed.analysis.model, previousReasoning);
      if (!next) {
        if (completed.execution?.escalationPending) return this.queue.update(completed.id, { execution: { ...completed.execution, escalationPending: false } })!;
        return completed;
      }

      const previousModel = codexModelId(completed.analysis.model);
      const nextModel = codexModelId(next.model);
      const at = new Date().toISOString();
      const detail = `The ${previousModel} ${previousReasoning} attempt failed. JEV will retry with ${nextModel} ${next.reasoning}.`;
      logJevApplied(`${previousModel} ${previousReasoning} → ${nextModel} ${next.reasoning}`, `[codex:${completed.id.slice(0, 8)}] automatic ticket escalation`);
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

  private async runTask(input: Job): Promise<Job> {
    const current = this.queue.get(input.id);
    if (!current) throw new Error("Job not found");
    if (current.status !== "PENDING" && current.status !== "ESCALATING") throw new Error(`Only pending or escalating jobs can run (${current.status})`);
    const first = current.analysis ? current : (await this.prepare(current))!;
    const model = first.analysis!.model;
    const modelId = await activeCodexModelId(model);
    const reasoning = first.analysis!.reasoning;
    const pausedThread = first.execution?.events.some(event => event.title === "Codex session limit reached") ? first.execution.threadId : undefined;
    const escalationThread = first.execution?.escalationPending ? first.execution.threadId : undefined;
    const continuingEscalation = current.status === "ESCALATING" || Boolean(first.execution?.escalationPending);
    const preserveExecution = continuingEscalation || Boolean(pausedThread);
    const previousExecution = preserveExecution ? first.execution : undefined;
    const excluded = new Set([first.id]);
    const history = this.queue.list(first.projectId);
    const blockedThreads = new Set(history.filter(job => implementationBlocked(job.output ?? "") || job.error?.startsWith("No project file changes were detected")).map(job => job.execution?.threadId).filter(Boolean));
    const previous = history.filter(job => !excluded.has(job.id) && job.status === "SUCCESS" && job.execution?.threadId && !job.execution.threadArchivedAt && !job.execution.threadResumeDisabledAt && !blockedThreads.has(job.execution.threadId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    let resumeThread = pausedThread && !blockedThreads.has(pausedThread) ? pausedThread : escalationThread ?? previous?.execution?.threadId;
    if (!pausedThread && !escalationThread && previous && resumeThread) {
      let continuity = previous.execution?.reviewedNextTaskId === first.id ? previous.execution.reviewedNextContinuity ?? "uncertain" : undefined;
      if (!continuity) {
        try { continuity = await this.taskContinuity([previous], first); }
        catch (error) { continuity = "uncertain"; logJevError(`[codex:${first.id.slice(0, 8)}] Thread continuity review unavailable: ${messageOf(error)}. Keeping the current thread.`); }
      }
      if (continuity === "unrelated") {
        const detail = `JEV found no task dependency between completed work and ticket ${first.id.slice(0, 8)}; this ticket starts a fresh Codex conversation.`;
        logJev(`[codex:${first.id.slice(0, 8)}] /clear START thread ${resumeThread}`);
        this.queue.appendProjectThreadEvent(first.projectId, resumeThread, "Codex /clear started", detail, "active");
        try {
          await this.archiver(resumeThread);
          this.queue.clearProjectThread(first.projectId, resumeThread, detail);
          logJev(`[codex:${first.id.slice(0, 8)}] /clear COMPLETED`);
        } catch (error) {
          this.queue.disableProjectThreadResume(first.projectId, resumeThread);
          const detail = `Thread archive failed (${messageOf(error)}); JEV disabled thread reuse and will start a fresh conversation.`;
          this.queue.appendProjectThreadEvent(first.projectId, resumeThread, "Automatic clear failed", detail, "error");
          logJevError(`[codex:${first.id.slice(0, 8)}] /clear FAILED: ${messageOf(error)}. Starting a fresh thread anyway.`);
        }
        resumeThread = undefined;
      }
    }
    const prompt = buildCodexPrompt(first.tasks, first.analysis!, first.attachments);
    const projectBefore = snapshotProject(first.projectPath);
    const startedAt = new Date().toISOString();
    const estimate = estimateExecutionTokens(prompt, first, reasoning, this.queue.list(first.projectId));
    const previousMetrics = previousExecution?.metrics;
    const routeIndex = previousMetrics?.routes.length ?? 0;
    const attemptNumber = first.attempts + 1;
    const initialEvent = { id: randomUUID(), timestamp: startedAt, kind: "system" as const, title: "Starting Codex", detail: first.projectPath, status: "active" as const };
    this.queue.transition(first.id, continuingEscalation ? "ESCALATING" : "RUNNING", {
      attempts: attemptNumber,
      output: preserveExecution ? first.output ?? "" : "",
      error: undefined,
      errorCategory: undefined,
      recoveryNote: undefined,
      execution: {
        ...previousExecution,
        phase: "STARTING",
        model: modelId,
        reasoning,
        startedAt: previousExecution?.startedAt ?? startedAt,
        lastActivityAt: startedAt,
        heartbeatAt: startedAt,
        pid: undefined,
        completedAt: undefined,
        escalationPending: continuingEscalation,
        projectChangesDetected: previousExecution?.projectChangesDetected ?? false,
        verification: "not_run",
        verificationNote: undefined,
        metrics: {
          estimatedTokens: (previousMetrics?.estimatedTokens ?? 0) + estimate.tokens,
          estimateBasis: previousMetrics?.estimateBasis ?? estimate.basis,
          actualTokens: previousMetrics?.actualTokens,
          turns: (previousMetrics?.turns ?? 0) + 1,
          routes: [...(previousMetrics?.routes ?? []), { stage: "implementation" as const, model: modelId, reasoning }]
        },
        events: [...(previousExecution?.events ?? []), initialEvent]
      }
    });
    return new Promise(resolve => {
      const common = ["--json", "--skip-git-repo-check", "--model", modelId, "-c", `model_reasoning_effort=\"${reasoning}\"`, ...codexHookArgs()];
      const imageArgs = (first.attachments ?? []).flatMap(attachment => ["--image", attachment.path]);
      const resumePrompt = pausedThread
        ? `${prompt}\n\nContinue the interrupted ticket in this thread. Review the work already made and finish the task. Use your judgment about any checks needed to verify the final result.`
        : continuingEscalation
          ? `${prompt}\n\nContinue this same ticket after a previous attempt. Inspect the work already made, correct what remains incomplete, and finish the requested task. Use your judgment about any checks needed to verify the final result.`
          : prompt;
      const args = [...codexExecPrefix(Boolean(resumeThread)), ...common, ...imageArgs, ...(resumeThread ? [resumeThread, resumePrompt] : [prompt])];
      const child = spawn("codex", args, { cwd: first.projectPath, shell: false, env: { ...process.env, JEV_HOOK_TASK: first.tasks.map(task => task.description).join(" ").slice(0, 2_000) } });
      child.stdin.end();
      let currentChild: ReturnType<typeof spawn> = child;
      let stalled = false;
      const heartbeat = setInterval(() => {
        const at = new Date().toISOString();
        const lastActivity = this.queue.get(first.id)?.execution?.lastActivityAt;
        if (!stalled && lastActivity && Date.now() - Date.parse(lastActivity) > 30 * 60_000 && currentChild.exitCode === null) {
          stalled = true;
          logJevError(`[codex:${first.id.slice(0, 8)}] No Codex activity for 30 minutes; stopping the stalled process.`);
          currentChild.kill("SIGTERM");
        }
        this.updateTicketExecution(first, execution => ({ ...execution, heartbeatAt: at }));
      }, 10_000);
      heartbeat.unref();
      const launchedAt = new Date().toISOString();
      const tag = first.id.slice(0, 8);
      const imagePaths = new Set((first.attachments ?? []).map(attachment => attachment.path));
      const visibleArgs = args.filter((arg, index) => !(/^(features\.hooks|hooks\.)/.test(arg) || (arg === "-c" && /^(features\.hooks|hooks\.)/.test(args[index + 1] ?? ""))));
      const commandSummary = `codex ${visibleArgs.map(arg => arg === prompt || arg === resumePrompt ? "<task prompt>" : imagePaths.has(arg) ? "<attached image>" : arg).join(" ")}`;
      logJevApplied(reasoning.toUpperCase(), `[codex:${tag}] ${modelId}`);
      process.stdout.write(`[codex:${tag}] EXEC ${commandSummary}\n`);
      const attachmentCount = first.attachments?.length ?? 0;
      this.updateTicketExecution(first, execution => ({ ...execution, pid: child.pid, lastActivityAt: launchedAt, events: [...execution.events, { id: randomUUID(), timestamp: launchedAt, kind: "system", title: "JEV route applied", detail: `Model used: ${modelId} · reasoning used: ${reasoning}`, status: "success" }, ...(attachmentCount ? [{ id: randomUUID(), timestamp: launchedAt, kind: "system" as const, title: "Visual references attached", detail: `${attachmentCount} image${attachmentCount === 1 ? "" : "s"} sent to Codex with --image.`, status: "success" as const }] : []), { id: randomUUID(), timestamp: launchedAt, kind: "command", title: "Codex command launched", detail: commandSummary, status: "success" }] }));
      const outputHeader = preserveExecution ? `\n\n--- JEV ${pausedThread ? "session resume" : "escalation attempt"} ${attemptNumber} · ${modelId} / ${reasoning} ---\n` : "";
      let rawOutput = `${preserveExecution ? first.output ?? "" : ""}${outputHeader}`.slice(-250_000); let currentAttemptOutput = ""; let stdoutBuffer = ""; let settled = false; let reportedFailure = false; let loopDetected = false; let usage: CodexUsage | undefined = previousExecution?.usage; let verification: Verification = "not_run";
      const loopDetector = new CodexLoopDetector(first.projectPath);
      let activeRouteIndex = routeIndex;
      let stageTurnFailed = false;
      let requestedRoute: { tier: CodexModel; effort: Reasoning } | undefined;
      const record = (line: string) => {
        if (!line.trim()) return;
        rawOutput = `${rawOutput}${line}\n`.slice(-250_000);
        currentAttemptOutput = `${currentAttemptOutput}${line}\n`.slice(-250_000);
        if (/^Reading additional input from stdin\.\.\.$/i.test(line.trim())) { this.updateTicketOutput(first, rawOutput); return; }
        let parsed: JsonEvent; try { parsed = JSON.parse(line) as JsonEvent; } catch { parsed = { type: "raw", message: line }; }
        const description = describe(parsed);
        const action = parsed.item ?? {};
        if ((parsed.type === "raw" || action.type === "error") && implementationBlocked(line)) reportedFailure = true;
        if (parsed.type === "item.completed" && /file|change|patch/i.test(String(action.type ?? ""))) loopDetector.reset();
        if (!loopDetected && parsed.type === "item.completed" && (action.type === "command_execution" || action.type === "agent_message")) {
          const repeated = action.type === "command_execution"
            ? loopDetector.observe("command", String(action.command ?? ""), String(action.aggregated_output ?? ""), typeof action.exit_code === "number" ? action.exit_code : undefined)
            : loopDetector.observe("message", String(action.text ?? ""));
          if (repeated) {
            loopDetected = true;
            stageTurnFailed = true;
            const detectedAt = new Date().toISOString();
            logJevError(`[codex:${tag}] Repeated Codex activity without project changes; stopping this execution to limit token use.`);
            this.updateTicketExecution(first, execution => ({ ...execution, events: [...execution.events, { id: randomUUID(), timestamp: detectedAt, kind: "error", title: "Repetition loop detected", detail: "Repeated commands or messages produced no project changes. JEV stopped Codex to avoid further token use.", status: "error" }] }));
            const loopingChild = currentChild;
            loopingChild.kill("SIGTERM");
            const escalation = setTimeout(() => { if (loopingChild.exitCode === null && loopingChild.signalCode === null) loopingChild.kill("SIGKILL"); }, 2_000);
            escalation.unref();
            loopingChild.once("close", () => clearTimeout(escalation));
          }
        }
        if (parsed.type === "turn.failed" || parsed.type === "error") stageTurnFailed = true;
        if (parsed.type === "turn.completed" && parsed.usage && typeof parsed.usage === "object") {
          const turnUsage = parsed.usage as CodexUsage;
          usage = Object.fromEntries(["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"].map(key => [key, ((usage as Record<string, number> | undefined)?.[key] ?? 0) + ((turnUsage as Record<string, number>)[key] ?? 0)])) as CodexUsage;
          this.updateTicketExecution(first, execution => ({ ...execution, metrics: execution.metrics ? { ...execution.metrics, routes: execution.metrics.routes.map((route, index) => index === activeRouteIndex ? { ...route, usage: turnUsage } : route) } : execution.metrics }));
        }
        const item = parsed.item ?? {};
        if (parsed.type === "item.completed" && item.type === "agent_message") reportedFailure = implementationBlocked(line);
        if (parsed.type === "item.completed" && item.type === "agent_message") {
          const requested = String(item.text ?? "").match(/(?:^|\n)JEV_ROUTE=([\w-]+):([\w-]+)\s*$/);
          requestedRoute = requested && MODEL_LEVELS.includes(requested[1]) && REASONING_LEVELS.includes(requested[2])
            ? { tier: requested[1], effort: requested[2] }
            : undefined;
        }
        if (parsed.type === "item.completed" && item.type === "command_execution" && item.exit_code === 0) {
          const command = String(item.command ?? "");
          if (/playwright|cypress|webdriver|browser/i.test(command)) verification = "functional_verified";
          else if (/\b(test|vitest|jest|pytest|cargo test|go test)\b/i.test(command) && verification !== "functional_verified") verification = "tests_passed";
          else if (/\b(build|tsc)\b/i.test(command) && verification === "not_run") verification = "build_only";
        }
        const now = new Date().toISOString();
        this.updateTicketExecution(first, execution => ({ ...execution, phase: description.phase, lastActivityAt: now, threadId: description.threadId ?? execution.threadId, events: description.item ? [...execution.events, { ...description.item, id: randomUUID(), timestamp: now }].slice(-250) : execution.events }));
        this.updateTicketOutput(first, rawOutput);
      };
      child.stdout.on("data", chunk => { const value = chunk.toString(); process.stdout.write(`[codex:${tag}] ${value}`); stdoutBuffer += value; const lines = stdoutBuffer.split("\n"); stdoutBuffer = lines.pop() ?? ""; lines.forEach(record); });
      child.stderr.on("data", chunk => { const value = chunk.toString(); process.stderr.write(`[codex:${tag}] ${value}`); record(value.trim()); });
      child.on("error", error => {
        if (settled) return; settled = true; clearInterval(heartbeat); const now = new Date().toISOString();
        resolve(this.queue.transition(first.id, "FAILED", { output: rawOutput, error: error.message, errorCategory: "codex", execution: { ...this.queue.get(first.id)!.execution!, phase: "ERROR", lastActivityAt: now, completedAt: now, events: [...this.queue.get(first.id)!.execution!.events, { id: randomUUID(), timestamp: now, kind: "error", title: "Could not start Codex", detail: error.message, status: "error" }] } })!);
      });
      child.on("close", async code => {
        if (settled) return; settled = true;
        if (stdoutBuffer) record(stdoutBuffer);
        let success = code === 0 && !reportedFailure && !stageTurnFailed;
        let failureMessage = stalled ? "Codex produced no activity for 30 minutes; the stalled process was stopped." : reportedFailure ? "Codex reported that it could not implement the task" : `Codex exited with code ${code}`;
        const runStage = async (tier: CodexModel, effort: Reasoning, instruction: string) => {
          const threadId = this.queue.get(first.id)?.execution?.threadId;
          if (!threadId) return { code: null, error: "Codex did not provide a thread ID for continuation" };
          const nextModelId = await activeCodexModelId(tier);
          stageTurnFailed = false; loopDetector.reset();
          const routedAt = new Date().toISOString();
          const previousSetting = this.queue.get(first.id)?.execution;
          const modelChanged = previousSetting?.model !== nextModelId;
          const change = `${(previousSetting?.reasoning ?? "unknown").toUpperCase()} → ${effort.toUpperCase()}`;
          logJevApplied(change, `[codex:${tag}] ${modelChanged ? `${previousSetting?.model ?? "unknown"} → ${nextModelId}` : nextModelId}`);
          activeRouteIndex += 1;
          this.updateTicketExecution(first, execution => ({ ...execution, model: nextModelId, reasoning: effort, lastActivityAt: routedAt, metrics: execution.metrics ? { ...execution.metrics, turns: execution.metrics.turns + 1, routes: [...execution.metrics.routes, { stage: "implementation", model: nextModelId, reasoning: effort }] } : execution.metrics, events: [...execution.events, { id: randomUUID(), timestamp: routedAt, kind: "system", title: modelChanged ? "Codex model changed" : "Codex reasoning changed", detail: `implementation: ${nextModelId} · ${effort} reasoning`, status: "active" }] }));
          return resumeCodexTurn(first.projectPath, threadId, nextModelId, effort, instruction, tag, record, resumed => { currentChild = resumed; this.updateTicketExecution(first, execution => ({ ...execution, pid: resumed.pid })); });
        };
        if (success) {
          let previousImplementationRoute: string | undefined;
          let routeBaseline = snapshotProject(first.projectPath);
          for (let attempt = 0; requestedRoute && success && attempt < 3; attempt++) {
            const route = requestedRoute;
            requestedRoute = undefined;
            const routeSignature = `${route.tier}:${route.effort}`;
            const routeCurrent = snapshotProject(first.projectPath);
            if (previousImplementationRoute === routeSignature && routeBaseline.size < 5000 && routeCurrent.size < 5000 && !changedProjectFiles(routeBaseline, routeCurrent).length) {
              loopDetected = true;
              success = false;
              failureMessage = "JEV stopped repeated implementation routing without project changes";
              const detectedAt = new Date().toISOString();
              logJevError(`[codex:${tag}] Repeated implementation route without project changes; stopping this execution to limit token use.`);
              this.updateTicketExecution(first, execution => ({ ...execution, events: [...execution.events, { id: randomUUID(), timestamp: detectedAt, kind: "error", title: "Repetition loop detected", detail: "Codex requested the same implementation route twice without changing project files. JEV stopped the ticket.", status: "error" }] }));
              break;
            }
            previousImplementationRoute = routeSignature;
            routeBaseline = routeCurrent;
            const currentModel = this.queue.get(first.id)?.execution?.model ?? modelId;
            const requestedModel = await activeCodexModelId(route.tier);
            if (requestedModel !== currentModel) logJev(`[codex:${tag}] Keeping ${currentModel}; JEV uses one model for the whole ticket.`);
            const requestedEffort = route.effort === "low" ? reasoningAt(0) : clampModelReasoning(model, route.effort);
            const continued = await runStage(model, requestedEffort, `Continue and finish the requested task. Keep model ${model} and vary only reasoning effort within its policy range. Inspect the project files needed to complete the task, including relevant implementation and direct dependencies. Use your judgment about running tests, builds, type checks, or other checks that would verify the result, and report the checks actually run. If a different reasoning effort is needed for a further implementation turn, end your final message with JEV_ROUTE=${model}:<effort>. Otherwise complete the task.`);
            success = continued.code === 0 && !continued.error && !stageTurnFailed && !reportedFailure;
            if (!success) failureMessage = continued.error ?? `Codex implementation turn exited with code ${continued.code}`;
          }
          if (requestedRoute && success) { success = false; failureMessage = "Codex requested more than three implementation routing turns"; }
        }
        const projectChangesDetected = Boolean(previousExecution?.projectChangesDetected || changedProjectFiles(projectBefore, snapshotProject(first.projectPath)).length);
        const expectsProjectChanges = first.analysis!.task_types.some(type => type !== "research" && type !== "architecture");
        if (success && expectsProjectChanges && !projectChangesDetected) {
          success = false;
          failureMessage = "No project file changes were detected for this implementation task. Review Codex output before retrying.";
          logJevError(`[codex:${tag}] ${failureMessage}`);
        }
        if (!loopDetected && sessionLimitReported(currentAttemptOutput)) {
          logSession(`[codex:${tag}] Codex usage limit reached; checking /status for the reset time.`);
          const limit = await this.rateLimitReader().catch((error): CodexRateLimit => ({ available: false, reached: false, unavailableReason: messageOf(error) }));
          const reportedRetry = retryTimeReported(currentAttemptOutput);
          const resetAt = [limit.resetsAt, reportedRetry].filter((value): value is string => Boolean(value)).sort().at(-1);
          const resumeAt = new Date(Math.max(Date.now(), resetAt ? Date.parse(resetAt) : Date.now()) + 60_000).toISOString();
          logSession(`[codex:${tag}] Session Paused; reset ${resetAt ?? "unknown"}, automatic resume at ${resumeAt}.`);
          clearInterval(heartbeat);
          this.queue.pauseForSessionLimit(first.id, resumeAt);
          this.updateTicketExecution(first, execution => ({ ...execution, projectChangesDetected }));
          resolve(this.queue.update(first.id, { output: rawOutput })!);
          return;
        }
        if (loopDetected) { success = false; failureMessage = failureMessage.startsWith("JEV stopped repeated") ? failureMessage : "JEV stopped repeated Codex activity without project changes"; }
        const now = new Date().toISOString();
        const representative = this.queue.get(first.id)!; let compactedAfterTask = false; let compactionError: string | undefined; let clearError: string | undefined;
        let codexStatus = await this.statusReader(representative.execution?.threadId).catch(error => ({ capturedAt: new Date().toISOString(), unavailableReason: messageOf(error) })) as CodexStatusSnapshot;
        let reviewedNextTaskId: string | undefined;
        let reviewedNextContinuity: "related" | "unrelated" | "uncertain" | undefined;
        if (representative.execution?.threadId) {
          const ordered = this.queue.listProjectExecutionOrder(first.projectId);
          const lastIndex = ordered.findIndex(candidate => candidate.id === first.id);
          const next = success ? ordered.slice(lastIndex + 1).find(job => job.status === "PENDING") ?? ordered.find(job => job.status === "PENDING") : undefined;
          let continuity: "related" | "unrelated" | "uncertain" = "uncertain";
          if (next) {
            try { continuity = await this.taskContinuity([first], next); }
            catch (error) { logJevError(`[codex:${tag}] Thread continuity review unavailable: ${messageOf(error)}. Keeping the current thread.`); }
            reviewedNextTaskId = next.id;
            reviewedNextContinuity = continuity;
          }
          if (success && continuity === "unrelated") {
            const detail = `JEV found no task dependency between completed work and next ticket ${next!.id.slice(0, 8)}; the next task starts a fresh Codex conversation.`;
            logJev(`[codex:${tag}] /clear START thread ${representative.execution.threadId}`);
            this.updateTicketExecution(first, execution => ({ ...execution, events: [...execution.events, { id: randomUUID(), timestamp: new Date().toISOString(), kind: "system", title: "Codex /clear started", detail, status: "active" }] }));
            try { await this.archiver(representative.execution.threadId); this.queue.clearProjectThread(first.projectId, representative.execution.threadId, detail); logJev(`[codex:${tag}] /clear COMPLETED`); }
            catch (error) { clearError = messageOf(error); this.queue.disableProjectThreadResume(first.projectId, representative.execution.threadId); logJevError(`[codex:${tag}] /clear FAILED: ${clearError}. The next ticket will start a fresh thread.`); }
          }
          if (success && next && continuity !== "unrelated" && (codexStatus.context?.usedTokens ?? 0) >= AUTO_COMPACTION_CONTEXT_TOKENS) {
            const reason = `Context reached ${codexStatus.context!.usedTokens.toLocaleString("en-US")} tokens (automatic threshold: ${AUTO_COMPACTION_CONTEXT_TOKENS.toLocaleString("en-US")}).`;
            logJev(`[codex:${tag}] /compact START thread ${representative.execution.threadId}`);
            this.updateTicketExecution(first, execution => ({ ...execution, lastActivityAt: now, events: [...execution.events, { id: randomUUID(), timestamp: now, kind: "system", title: "Codex /compact started", detail: `Thread ${representative.execution!.threadId} — ${reason}`, status: "active" }] }));
            try { await this.compactor(representative.execution.threadId); compactedAfterTask = true; codexStatus = await this.statusReader(representative.execution.threadId).catch(() => codexStatus); }
            catch (error) { compactionError = messageOf(error); }
          }
        }
        const accountUsage = await this.accountUsageReader().catch(error => ({ capturedAt: new Date().toISOString(), unavailableReason: messageOf(error) }));
        if (compactedAfterTask) logJev(`[codex:${tag}] /compact COMPLETED`);
        if (compactionError) logJevError(`[codex:${tag}] /compact FAILED: ${compactionError}`);
        const latest = this.queue.get(first.id)!;
        const checkpoint: ExecutionEvent = { id: randomUUID(), timestamp: now, kind: "system", title: "Codex status checkpoint", detail: JSON.stringify({ model: latest.execution?.model, reasoning: latest.execution?.reasoning, taskUsage: usage, accountUsage, codexStatus, verification }), status: "success" };
        const compactEvents: ExecutionEvent[] = compactedAfterTask ? [{ id: randomUUID(), timestamp: now, kind: "system", title: "Codex /compact confirmed", detail: "Codex app-server confirmed JEV's automatic compaction.", status: "success" }] : compactionError ? [{ id: randomUUID(), timestamp: now, kind: "error", title: "Automatic compaction failed", detail: compactionError, status: "error" }] : [];
        if (clearError) compactEvents.push({ id: randomUUID(), timestamp: now, kind: "error", title: "Automatic clear failed", detail: clearError, status: "error" });
        const completed = this.queue.transition(first.id, success ? "SUCCESS" : "FAILED", { output: rawOutput, error: success ? undefined : failureMessage, errorCategory: success ? undefined : (loopDetected ? "loop" : stalled ? "interruption" : reportedFailure ? "code" : "codex"), execution: { ...latest.execution!, phase: success ? "COMPLETED" : "ERROR", escalationPending: false, projectChangesDetected, lastActivityAt: now, completedAt: now, usage, accountUsage, codexStatus, metrics: latest.execution!.metrics ? { ...latest.execution!.metrics, actualTokens: totalCodexTokens(usage) } : latest.execution!.metrics, verification, compactedAfterTask, reviewedNextTaskId, reviewedNextContinuity, events: [...latest.execution!.events, checkpoint, ...compactEvents, { id: randomUUID(), timestamp: now, kind: success ? "system" : "error", title: success ? "Execution completed" : "Execution failed", detail: success ? (verification === "functional_verified" ? "Codex finished with functional verification." : verification === "tests_passed" ? "Codex finished and automated tests passed." : verification === "build_only" ? "Codex finished; compilation passed but functional behavior was not verified." : "Codex finished without a detected verification command.") : failureMessage, status: success ? "success" : "error" }] } })!;
        clearInterval(heartbeat);
        if (success) logTicketCompleted(tag, first.tasks[0]?.description ?? first.id);
        resolve(completed);
      });
    });
  }

  private updateTicketExecution(job: Job, mutate: (execution: NonNullable<Job["execution"]>) => NonNullable<Job["execution"]>) { const current = this.queue.get(job.id); if (current?.execution) this.queue.update(job.id, { execution: mutate(current.execution) }); }
  private updateTicketOutput(job: Job, output: string) { this.queue.update(job.id, { output }); }
}
