import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { codexModelId, REASONING_LEVELS } from "./codex-models.js";
import { activeCodexModelId } from "./codex-catalog.js";
import { readCodexStatusSnapshot } from "./codex-status.js";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { analyze, assessVerification } from "./analyzer.js";
import { logJev, logJevError } from "./jev-logger.js";
import { buildCodexCommand, buildCodexGroupPrompt, buildCodexPrompt } from "./prompt.js";
import { affectedTests, changedProjectFiles, snapshotProject, targetedTestCommand } from "./verification-scope.js";
import { codexHookArgs } from "./hooks/codex-config.js";
import type { JobQueue } from "./queue.js";
import type { CodexAccountUsage, CodexModel, CodexStatusSnapshot, CodexUsage, ExecutionEvent, ExecutionPhase, Job, Reasoning } from "./types.js";

type JsonEvent = Record<string, unknown> & { type?: string; item?: Record<string, unknown> };
type Verification = "not_run" | "build_only" | "tests_passed" | "functional_verified" | "environment_blocked";
type CodexRateLimit = { available: boolean; reached: boolean; resetsAt?: string; unavailableReason?: string };
const reasoningRank = Object.fromEntries(REASONING_LEVELS.map((level, index) => [level, index])) as Record<Reasoning, number>;

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

function estimateExecutionTokens(prompt: string, jobs: Job[], reasoning: Reasoning, history: Job[]) {
  const promptTokens = Math.ceil(prompt.length / 4);
  const complexityReserve = { trivial: 300, low: 700, medium: 1_400, high: 2_600, very_high: 4_500 };
  const reasoningReserve = { low: 300, medium: 700, high: 1_400, xhigh: 2_500 };
  const scopeReserve = jobs.reduce((total, job) => total + ((job.analysis?.context_files.length ?? 0) + (job.analysis?.files_to_modify.length ?? 0)) * 80, 0);
  const workReserve = jobs.reduce((total, job) => total + complexityReserve[job.analysis!.complexity], 0);
  const scopeEstimate = Math.max(1_000, Math.ceil((promptTokens + scopeReserve + workReserve + reasoningReserve[reasoning] + 500) / 100) * 100);
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
function sessionLimitReported(output: string) { return /(?:5[- ]?hour|session|usage|rate)[_ -]?(?:limit|quota).{0,100}(?:reached|exceeded)|(?:reached|exceeded).{0,100}(?:5[- ]?hour|session|usage|rate)[_ -]?(?:limit|quota)|rate_limit_exceeded/i.test(output); }

function missingVerificationDependencies(output: string): string[] {
  const names = [...output.matchAll(/(?:No module named|ModuleNotFoundError:\s*No module named|Cannot find module)\s+['"`]?([\w.-]+)/gi)].map(match => match[1]);
  names.push(...[...output.matchAll(/(?:^|\n)([\w.-]+):\s*command not found/gi)].map(match => match[1]));
  for (const block of output.matchAll(/ERROR Unmet dependencies[^\n]*\n([\s\S]*?)(?=\n(?:STATUS\b|ERROR\b|\* |$))/gi)) {
    names.push(...[...block[1].matchAll(/^\s+([\w.-]+)\s*\n\s+wanted:[^\n]*\n\s+found:\s*not installed\b/gmi)].map(match => match[1]));
  }
  return [...new Set(names)];
}

function verificationDecision(outcome: "passed" | "failed" | "environment_blocked" | undefined, commands: Array<{ output: string; exitCode?: number }>) {
  const blockers = [...new Set(commands.flatMap(command => missingVerificationDependencies(command.output)))];
  const hasCodeFailure = commands.some(command => /(?:\b\d+\s+failed\b|AssertionError|error TS\d+|SyntaxError|(?:^|\n)FAIL\s+|FAILED\s+\S+::)/i.test(command.output));
  const unexplainedCommandFailure = commands.some(command => command.exitCode !== undefined && command.exitCode !== 0 && !missingVerificationDependencies(command.output).length);
  if ((blockers.length || outcome === "environment_blocked") && !hasCodeFailure && !unexplainedCommandFailure) return { kind: "environment_blocked" as const, blockers };
  if (outcome === "passed" && !hasCodeFailure) return { kind: "passed" as const, blockers: [] };
  if (outcome === "failed" || outcome === "environment_blocked" || hasCodeFailure || unexplainedCommandFailure) return { kind: "failed" as const, blockers: [] };
  return { kind: "passed" as const, blockers: [] };
}

/** Performs this backend operation. */
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
    const args = ["exec", "resume", "--json", "--skip-git-repo-check", "--model", modelId, "-c", `model_reasoning_effort=\"${reasoning}\"`, ...codexHookArgs(), threadId, prompt];
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

/** Performs this backend operation. */
export class Orchestrator {
  private runningBatches = new Set<string>();
  private runningProjects = new Set<string>();
  constructor(private queue: JobQueue, private analyzer = analyze, private compactor: (threadId: string) => Promise<void> = compactThread, private accountUsageReader: () => Promise<CodexAccountUsage> = readCodexAccountUsage, private archiver: (threadId: string) => Promise<void> = archiveThread, private rateLimitReader: () => Promise<CodexRateLimit> = readCodexRateLimit, private statusReader: (threadId?: string) => Promise<CodexStatusSnapshot> = readCodexStatusSnapshot, private verificationReviewer: (task: string, changedFiles: string[], candidateTests: string[]) => Promise<boolean> = assessVerification) {}

  async prepare(job: Job) {
    if (!existsSync(job.projectPath)) throw new Error(`Project not found: ${job.projectPath}`);
    if (job.analysis) return job;
    logJev(`Preparing recommendation for task ${job.id.slice(0, 8)}`);
    try {
      const analysis = await this.analyzer(job.projectPath, job.tasks);
      logJev(`JEV recommends ${codexModelId(analysis.model)} with ${analysis.reasoning} reasoning for task ${job.id.slice(0, 8)} · precision ${analysis.precision_score ?? "unavailable"}% · task breakdown ${analysis.decomposition_score ?? "unavailable"}%`);
      return this.queue.update(job.id, { analysis });
    } catch (error) {
      logJevError(`Recommendation unavailable for task ${job.id.slice(0, 8)} · ${messageOf(error)}`);
      this.queue.update(job.id, { error: messageOf(error), errorCategory: "jev" });
      throw error;
    }
  }

  isProjectRunning(projectId: string) { return this.runningProjects.has(projectId) || this.queue.list(projectId).some(job => job.status === "RUNNING"); }
  ownsProjectRun(projectId: string) { return this.runningProjects.has(projectId); }
  isBatchRunning(id: string) { const job = this.queue.get(id); return Boolean(job && (this.isProjectRunning(job.projectId) || this.runningBatches.has(job.batchId ?? job.id))); }

  async resumeSessionPausedJobs() {
    const paused = this.queue.list().filter(job => job.status === "SESSION_PAUSED" && !this.isProjectRunning(job.projectId));
    if (!paused.length) return [];
    const limits = await this.rateLimitReader().catch(error => ({ available: false, reached: false, unavailableReason: messageOf(error) }));
    if (!limits.available || limits.reached) return [];
    const now = Date.now();
    const eligible = paused.filter(job => !job.sessionResumeAt || Date.parse(job.sessionResumeAt) <= now);
    for (const job of eligible) this.queue.resumeSessionPaused(job.id);
    return [...new Set(eligible.map(job => job.projectId))]
      .map(projectId => this.queue.listProjectExecutionOrder(projectId).find(job => job.status === "PENDING"))
      .filter((job): job is Job => Boolean(job));
  }

  projectThreadStatus(projectId: string) {
    return { threadId: this.queue.activeProjectThread(projectId), successfulSinceCompaction: this.queue.successesSinceCompaction(projectId) };
  }

  async command(job: Job) { const prepared = job.analysis ? job : (await this.prepare(job))!; return buildCodexCommand(prepared.tasks, prepared.analysis!, await activeCodexModelId(prepared.analysis!.model)); }

  async runBatch(id: string): Promise<void> {
    const first = this.queue.get(id);
    if (!first) throw new Error("Job not found");
    const batchId = first.batchId ?? first.id;
    if (this.runningBatches.has(batchId)) throw new Error("This task sequence is already running");
    if (this.isProjectRunning(first.projectId)) throw new Error("A Codex execution is already running for this project");
    this.runningBatches.add(batchId);
    this.runningProjects.add(first.projectId);
    try {
      let snapshot = first.batchId ? this.queue.listBatch(first.batchId) : [first];
      for (const job of snapshot) if (!job.analysis && job.status === "PENDING") await this.prepare(job);
      snapshot = await this.extendWithCompatibleProjectTickets(snapshot);
      const retried = new Set<string>();
      let cursor = 0;
      while (cursor < snapshot.length) {
        const current = this.queue.get(snapshot[cursor].id);
        if (!current || current.status === "SUCCESS" || current.status === "SKIPPED") { cursor++; continue; }
        if (current.status === "SESSION_PAUSED") break;
        const group = current.status === "PENDING" ? this.compatibleGroup(snapshot, cursor) : [current];
        cursor += group.length;
        try {
          const completed = await this.runGroup(group);
          if (completed.some(job => job.status === "SESSION_PAUSED")) break;
          const lastOrder = Math.max(...completed.filter(job => job.status === "SUCCESS").map(job => job.order ?? Number.MAX_SAFE_INTEGER), -1);
          if (lastOrder < 0) continue;
          const failures = this.queue.listBatch(batchId).filter(job => job.status === "FAILED" && (job.order ?? Number.MAX_SAFE_INTEGER) < lastOrder && !retried.has(job.id));
          for (const failed of failures) {
            retried.add(failed.id);
            try { this.queue.scheduleAutomaticRetry(failed.id, completed[0]?.tasks[0]?.description ?? "a later task"); await this.runGroup([failed]); }
            catch (error) { const retry = this.queue.get(failed.id); if (retry && retry.status !== "SUCCESS") this.queue.transition(failed.id, "FAILED", { error: messageOf(error), errorCategory: "codex" }); }
          }
        } catch (error) {
          for (const job of group) { const latest = this.queue.get(job.id); if (latest && latest.status !== "SUCCESS") this.queue.transition(job.id, "FAILED", { error: messageOf(error), errorCategory: "codex" }); }
        }
      }
    } finally { this.runningBatches.delete(batchId); this.runningProjects.delete(first.projectId); }
  }

  async run(id: string): Promise<Job> {
    const job = this.queue.get(id);
    if (!job) throw new Error("Job not found");
    if (this.isProjectRunning(job.projectId)) throw new Error("A Codex execution is already running for this project");
    this.runningProjects.add(job.projectId);
    try { return (await this.runGroup([job]))[0]; }
    finally { this.runningProjects.delete(job.projectId); }
  }

  async compactProjectThread(projectId: string) {
    if (this.queue.list(projectId).some(job => job.status === "RUNNING")) throw new Error("Wait for the active Codex execution to finish before compacting this project thread.");
    const threadId = this.queue.activeProjectThread(projectId);
    if (!threadId) throw new Error("This project has no active Codex thread to compact yet.");
    process.stdout.write(`\x1b[33m[codex:${projectId.slice(0, 8)}] /compact MANUAL START thread ${threadId}\x1b[0m\n`);
    this.queue.appendProjectThreadEvent(projectId, threadId, "Codex /compact started", "Manual compaction requested from JEV Codex Pilot.", "active");
    await this.compactor(threadId);
    this.queue.markProjectCompacted(projectId);
    this.queue.appendProjectThreadEvent(projectId, threadId, "Codex /compact confirmed", "Codex app-server confirmed manual compaction. The automatic counter was reset.");
    process.stdout.write(`\x1b[33m[codex:${projectId.slice(0, 8)}] /compact MANUAL COMPLETED\x1b[0m\n`);
    return { threadId, successfulSinceCompaction: this.queue.successesSinceCompaction(projectId) };
  }

  async clearProjectThread(projectId: string) {
    if (this.queue.list(projectId).some(job => job.status === "RUNNING")) throw new Error("Wait for the active Codex execution to finish before clearing this project thread.");
    const threadId = this.queue.activeProjectThread(projectId);
    if (!threadId) throw new Error("This project has no active Codex thread to clear yet.");
    process.stdout.write(`\x1b[33m[codex:${projectId.slice(0, 8)}] /clear START thread ${threadId}\x1b[0m\n`);
    await this.archiver(threadId);
    this.queue.clearProjectThread(projectId, threadId);
    process.stdout.write(`\x1b[33m[codex:${projectId.slice(0, 8)}] /clear COMPLETED — next task starts a new thread\x1b[0m\n`);
    return { threadId, successfulSinceCompaction: this.queue.successesSinceCompaction(projectId) };
  }

  private compatibleGroup(snapshot: Job[], start: number): Job[] {
    const first = this.queue.get(snapshot[start].id)!;
    const room = Math.max(1, 3 - this.queue.successesSinceCompaction(first.projectId));
    const group = [first];
    let minimum = reasoningRank[first.analysis!.reasoning];
    let maximum = minimum;
    for (let index = start + 1; index < snapshot.length && group.length < Math.min(3, room); index++) {
      const candidate = this.queue.get(snapshot[index].id);
      if (!candidate || candidate.status !== "PENDING" || !candidate.analysis || candidate.projectId !== first.projectId || candidate.analysis.model !== first.analysis!.model) break;
      const rank = reasoningRank[candidate.analysis.reasoning];
      // Direction does not matter: Medium → Low is as compatible as Low → Medium.
      if (Math.max(maximum, rank) - Math.min(minimum, rank) > 1) break;
      minimum = Math.min(minimum, rank); maximum = Math.max(maximum, rank); group.push(candidate);
    }
    return group;
  }

  /**
   * A ticket submitted later may be the immediate next item in the same project
   * queue, even when it belongs to a different UI submission batch. Include that
   * compatible tail so it can share the same prompt instead of a second process.
   */
  private async extendWithCompatibleProjectTickets(snapshot: Job[]): Promise<Job[]> {
    const tail = snapshot.at(-1) ? this.queue.get(snapshot.at(-1)!.id) : undefined;
    if (!tail?.analysis) return snapshot;
    const ordered = this.queue.listProjectExecutionOrder(tail.projectId);
    const tailIndex = ordered.findIndex(job => job.id === tail.id);
    if (tailIndex < 0) return snapshot;
    const room = Math.max(1, 3 - this.queue.successesSinceCompaction(tail.projectId));
    const result = [...snapshot];
    let minimum = reasoningRank[tail.analysis.reasoning];
    let maximum = minimum;
    for (let index = tailIndex + 1; index < ordered.length && result.length - snapshot.length < Math.max(0, room - 1); index++) {
      const candidate = this.queue.get(ordered[index].id);
      if (!candidate || candidate.status === "SUCCESS" || candidate.status === "SKIPPED") continue;
      if (candidate.status !== "PENDING") break;
      const prepared = candidate.analysis ? candidate : (await this.prepare(candidate))!;
      if (prepared.analysis!.model !== tail.analysis.model) break;
      const rank = reasoningRank[prepared.analysis!.reasoning];
      if (Math.max(maximum, rank) - Math.min(minimum, rank) > 1) break;
      minimum = Math.min(minimum, rank);
      maximum = Math.max(maximum, rank);
      result.push(prepared);
    }
    return result;
  }

  private async runGroup(input: Job[]): Promise<Job[]> {
    const prepared = await Promise.all(input.map(async job => {
      const current = this.queue.get(job.id);
      if (!current) throw new Error("Job not found");
      if (current.status !== "PENDING") throw new Error(`Only pending jobs can run (${current.status})`);
      return current.analysis ? current : (await this.prepare(current))!;
    }));
    const first = prepared[0];
    const model = first.analysis!.model;
    const modelId = await activeCodexModelId(model);
    if (prepared.some(job => job.projectId !== first.projectId || job.projectPath !== first.projectPath || job.analysis!.model !== model)) throw new Error("Only tasks from the same project with the same model can share a Codex prompt.");
    const ranks = prepared.map(job => reasoningRank[job.analysis!.reasoning]);
    if (Math.max(...ranks) - Math.min(...ranks) > 1) throw new Error("Grouped tasks may differ by at most one reasoning level.");
    const reasoning = prepared.map(job => job.analysis!.reasoning).sort((a, b) => reasoningRank[b] - reasoningRank[a])[0];
    const groupId = prepared.length > 1 ? randomUUID() : undefined;
    const prompt = prepared.length === 1 ? buildCodexPrompt(first.tasks, first.analysis!, first.attachments) : buildCodexGroupPrompt(prepared);
    const projectBefore = snapshotProject(first.projectPath);
    const startedAt = new Date().toISOString();
    const estimate = estimateExecutionTokens(prompt, prepared, reasoning, this.queue.list(first.projectId));
    for (const [index, job] of prepared.entries()) {
      this.queue.transition(job.id, "RUNNING", { attempts: job.attempts + 1, output: "", error: undefined, errorCategory: undefined, recoveryNote: undefined, execution: { phase: "STARTING", model: modelId, reasoning, startedAt, lastActivityAt: startedAt, heartbeatAt: startedAt, verification: "not_run", metrics: { estimatedTokens: estimate.tokens, estimateBasis: estimate.basis, turns: 1, repairs: 0, routes: [{ stage: "implementation", model: modelId, reasoning }] }, group: groupId ? { id: groupId, size: prepared.length, position: index + 1 } : undefined, events: [{ id: randomUUID(), timestamp: startedAt, kind: "system", title: "Starting Codex", detail: job.projectPath, status: "active" }, ...(groupId ? [{ id: randomUUID(), timestamp: startedAt, kind: "system" as const, title: "Compatible tasks grouped", detail: `${prepared.length} independently analysed tasks share this Codex prompt. Effective setting: ${modelId} · ${reasoning}.`, status: "success" as const }] : [])] } });
    }
    return new Promise(resolve => {
      const excluded = new Set(prepared.map(job => job.id));
      const previous = this.queue.list(first.projectId).filter(job => !excluded.has(job.id) && job.status === "SUCCESS" && job.execution?.threadId && !job.execution.threadArchivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const common = ["--json", "--skip-git-repo-check", "--model", modelId, "-c", `model_reasoning_effort=\"${reasoning}\"`, ...codexHookArgs()];
      const imageArgs = prepared.flatMap(job => (job.attachments ?? []).flatMap(attachment => ["--image", attachment.path]));
      const args = previous?.execution?.threadId ? ["exec", "resume", ...common, ...imageArgs, previous.execution.threadId, prompt] : ["exec", ...common, "--color", "never", "--approve-for-me", ...imageArgs, prompt];
      const child = spawn("codex", args, { cwd: first.projectPath, shell: false, env: { ...process.env, JEV_HOOK_TASK: prepared.map(job => job.tasks.map(task => task.description).join(" ")).join(" ").slice(0, 2_000) } });
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
        this.updateGroup(prepared, execution => ({ ...execution, heartbeatAt: at }));
      }, 10_000);
      heartbeat.unref();
      const launchedAt = new Date().toISOString();
      const tag = prepared.length > 1 ? `${first.id.slice(0, 8)}+${prepared.length - 1}` : first.id.slice(0, 8);
      const imagePaths = new Set(prepared.flatMap(job => (job.attachments ?? []).map(attachment => attachment.path)));
      const visibleArgs = args.filter((arg, index) => !(/^(features\.hooks|hooks\.)/.test(arg) || (arg === "-c" && /^(features\.hooks|hooks\.)/.test(args[index + 1] ?? ""))));
      const commandSummary = `codex ${visibleArgs.map(arg => arg === prompt ? "<task prompt>" : imagePaths.has(arg) ? "<attached image>" : arg).join(" ")}`;
      logJev(`[codex:${tag}] Selected model=${modelId} reasoning=${reasoning}${groupId ? ` group=${prepared.length}` : ""}`);
      process.stdout.write(`[codex:${tag}] EXEC ${commandSummary}\n`);
      const attachmentCount = prepared.reduce((total, job) => total + (job.attachments?.length ?? 0), 0);
      this.updateGroup(prepared, execution => ({ ...execution, pid: child.pid, lastActivityAt: launchedAt, events: [...execution.events, { id: randomUUID(), timestamp: launchedAt, kind: "system", title: "JEV selection applied", detail: `Model used: ${modelId} · reasoning used: ${reasoning}`, status: "success" }, ...(attachmentCount ? [{ id: randomUUID(), timestamp: launchedAt, kind: "system" as const, title: "Visual references attached", detail: `${attachmentCount} image${attachmentCount === 1 ? "" : "s"} sent to Codex with --image.`, status: "success" as const }] : []), { id: randomUUID(), timestamp: launchedAt, kind: "command", title: "Codex command launched", detail: commandSummary, status: "success" }] }));
      let rawOutput = ""; let stdoutBuffer = ""; let settled = false; let reportedFailure = false; let usage: CodexUsage | undefined; let verification: Verification = "not_run";
      let activeStage: "implementation" | "verification" | "repair" = "implementation";
      let activeRouteIndex = 0;
      let stageTurnFailed = false; let verificationOutcome: "passed" | "failed" | "environment_blocked" | undefined;
      let verificationBlockers: string[] = [];
      let verificationSkipReason: string | undefined;
      let verificationCommands: Array<{ output: string; exitCode?: number }> = [];
      let approvedTests: string[] = [];
      let executedTests = new Set<string>();
      let verificationOutOfScope = false;
      let requestedRoute: { tier: CodexModel; effort: Reasoning } | undefined;
      const record = (line: string) => {
        if (!line.trim()) return;
        if (/patch rejected|writing is blocked|impossible d['’]implémenter|could not implement|unable to implement/i.test(line)) reportedFailure = true;
        rawOutput = `${rawOutput}${line}\n`.slice(-250_000);
        if (/^Reading additional input from stdin\.\.\.$/i.test(line.trim())) { this.updateGroupOutput(prepared, rawOutput); return; }
        let parsed: JsonEvent; try { parsed = JSON.parse(line) as JsonEvent; } catch { parsed = { type: "raw", message: line }; }
        const description = describe(parsed);
        if (parsed.type === "turn.failed" || parsed.type === "error") stageTurnFailed = true;
        if (parsed.type === "turn.completed" && parsed.usage && typeof parsed.usage === "object") {
          const turnUsage = parsed.usage as CodexUsage;
          usage = Object.fromEntries(["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"].map(key => [key, ((usage as Record<string, number> | undefined)?.[key] ?? 0) + ((turnUsage as Record<string, number>)[key] ?? 0)])) as CodexUsage;
          this.updateGroup(prepared, execution => ({ ...execution, metrics: execution.metrics ? { ...execution.metrics, routes: execution.metrics.routes.map((route, index) => index === activeRouteIndex ? { ...route, usage: turnUsage } : route) } : execution.metrics }));
        }
        const item = parsed.item ?? {};
        if (activeStage === "implementation" && parsed.type === "item.completed" && item.type === "agent_message") {
          const requested = String(item.text ?? "").match(/(?:^|\n)JEV_ROUTE=(luna|terra|sol):(low|medium|high|xhigh)\s*$/);
          requestedRoute = requested ? { tier: requested[1] as CodexModel, effort: requested[2] as Reasoning } : undefined;
        }
        if (activeStage === "verification" && parsed.type === "item.completed" && item.type === "command_execution") {
          const command = String(item.command ?? "");
          const covered = approvedTests.filter(path => command.includes(path));
          const inScope = covered.length > 0 && /\b(vitest|jest|pytest)\b/.test(command) && !/\bnpm\s+(?:run\s+)?test\b/.test(command);
          if (inScope) { covered.forEach(path => executedTests.add(path)); verificationCommands.push({ output: String(item.aggregated_output ?? ""), exitCode: typeof item.exit_code === "number" ? item.exit_code : undefined }); }
          else { verificationOutOfScope = true; logJev(`[codex:${tag}] Ignoring a verification command outside JEV's approved test scope.`); }
        }
        if (activeStage === "verification" && parsed.type === "item.completed" && item.type === "agent_message") {
          const message = String(item.text ?? "");
          if (/JEV_VERIFICATION_PASSED/.test(message)) verificationOutcome = "passed";
          if (/JEV_VERIFICATION_FAILED/.test(message)) verificationOutcome = "failed";
          if (/JEV_VERIFICATION_ENVIRONMENT_BLOCKED/.test(message)) verificationOutcome = "environment_blocked";
        }
        if (activeStage === "verification" && parsed.type === "item.completed" && item.type === "command_execution" && item.exit_code === 0 && !verificationOutOfScope) {
          const command = String(item.command ?? "");
          if (/playwright|cypress|webdriver|browser/i.test(command)) verification = "functional_verified";
          else if (/\b(test|vitest|jest|pytest|cargo test|go test)\b/i.test(command) && verification !== "functional_verified") verification = "tests_passed";
          else if (/\b(build|tsc)\b/i.test(command) && verification === "not_run") verification = "build_only";
        }
        const now = new Date().toISOString();
        if (description.threadId) this.queue.recordProjectThread(first.projectId, description.threadId);
        this.updateGroup(prepared, execution => ({ ...execution, phase: description.phase, lastActivityAt: now, threadId: description.threadId ?? execution.threadId, events: description.item ? [...execution.events, { ...description.item, id: randomUUID(), timestamp: now }].slice(-250) : execution.events }));
        this.updateGroupOutput(prepared, rawOutput);
      };
      child.stdout.on("data", chunk => { const value = chunk.toString(); process.stdout.write(`[codex:${tag}] ${value}`); stdoutBuffer += value; const lines = stdoutBuffer.split("\n"); stdoutBuffer = lines.pop() ?? ""; lines.forEach(record); });
      child.stderr.on("data", chunk => { const value = chunk.toString(); process.stderr.write(`[codex:${tag}] ${value}`); record(value.trim()); });
      child.on("error", error => {
        if (settled) return; settled = true; clearInterval(heartbeat); const now = new Date().toISOString();
        resolve(prepared.map(job => this.queue.transition(job.id, "FAILED", { output: rawOutput, error: error.message, errorCategory: "codex", execution: { ...this.queue.get(job.id)!.execution!, phase: "ERROR", lastActivityAt: now, completedAt: now, events: [...this.queue.get(job.id)!.execution!.events, { id: randomUUID(), timestamp: now, kind: "error", title: "Could not start Codex", detail: error.message, status: "error" }] } })!));
      });
      child.on("close", async code => {
        if (settled) return; settled = true;
        if (stdoutBuffer) record(stdoutBuffer);
        let success = code === 0 && !reportedFailure && !stageTurnFailed;
        let failureMessage = stalled ? "Codex produced no activity for 30 minutes; the stalled process was stopped." : reportedFailure ? "Codex reported that it could not implement the task" : `Codex exited with code ${code}`;
        if (!success && sessionLimitReported(rawOutput)) {
          const limit = await this.rateLimitReader().catch((error): CodexRateLimit => ({ available: false, reached: false, unavailableReason: messageOf(error) }));
          const resumeAt = limit.resetsAt ?? new Date(Date.now() + 5 * 60 * 60 * 1_000).toISOString();
          logJev(`[codex:${tag}] Codex session limit reached; development paused until ${resumeAt}`);
          clearInterval(heartbeat);
          resolve(prepared.map(job => {
            this.queue.pauseForSessionLimit(job.id, resumeAt);
            return this.queue.update(job.id, { output: rawOutput })!;
          }));
          return;
        }
        const runStage = async (stage: "implementation" | "verification" | "repair", tier: CodexModel, effort: Reasoning, instruction: string) => {
          const threadId = this.queue.get(first.id)?.execution?.threadId;
          if (!threadId) return { code: null, error: "Codex did not provide a thread ID for continuation" };
          const nextModelId = await activeCodexModelId(tier);
          activeStage = stage; stageTurnFailed = false;
          if (stage === "verification") { verificationCommands = []; verificationOutcome = undefined; verificationOutOfScope = false; executedTests = new Set(); }
          const routedAt = new Date().toISOString();
          const previousSetting = this.queue.get(first.id)?.execution;
          const modelChanged = previousSetting?.model !== nextModelId;
          logJev(`[codex:${tag}] ${modelChanged ? "Model and reasoning" : "Reasoning"} route for ${stage}: ${previousSetting?.model ?? "unknown"}/${previousSetting?.reasoning ?? "unknown"} → ${nextModelId}/${effort}`);
          activeRouteIndex += 1;
          this.updateGroup(prepared, execution => ({ ...execution, model: nextModelId, reasoning: effort, lastActivityAt: routedAt, metrics: execution.metrics ? { ...execution.metrics, turns: execution.metrics.turns + 1, repairs: execution.metrics.repairs + (stage === "repair" ? 1 : 0), routes: [...execution.metrics.routes, { stage, model: nextModelId, reasoning: effort }] } : execution.metrics, events: [...execution.events, { id: randomUUID(), timestamp: routedAt, kind: "system", title: modelChanged ? "Codex model changed" : "Codex reasoning changed", detail: `${stage}: ${nextModelId} · ${effort} reasoning`, status: "active" }] }));
          return resumeCodexTurn(first.projectPath, threadId, nextModelId, effort, instruction, tag, record, resumed => { currentChild = resumed; this.updateGroup(prepared, execution => ({ ...execution, pid: resumed.pid })); });
        };
        if (success) {
          for (let attempt = 0; requestedRoute && success && attempt < 3; attempt++) {
            const route = requestedRoute;
            requestedRoute = undefined;
            const currentModel = this.queue.get(first.id)?.execution?.model ?? modelId;
            const requestedModel = await activeCodexModelId(route.tier);
            if (requestedModel !== currentModel) logJev(`[codex:${tag}] Keeping ${currentModel} for implementation; model escalation requires repeated failed verification.`);
            const continued = await runStage("implementation", model, route.effort, "Continue and finish the implementation requested in the previous turn. Do not run tests or build checks; JEV will decide whether targeted tests are needed after implementation. Inspect only the JEV-selected files and direct dependencies. If a different reasoning effort is needed for a further implementation turn, end your final message with JEV_ROUTE=<tier>:<effort>. Otherwise complete the implementation.");
            success = continued.code === 0 && !continued.error && !stageTurnFailed && !reportedFailure;
            if (!success) failureMessage = continued.error ?? `Codex implementation turn exited with code ${continued.code}`;
          }
          if (requestedRoute && success) { success = false; failureMessage = "Codex requested more than three implementation routing turns"; }
        }
        const chooseVerification = async () => {
          const current = snapshotProject(first.projectPath);
          const changed = changedProjectFiles(projectBefore, current);
          const candidates = affectedTests(changed, current, first.projectPath);
          const command = targetedTestCommand(first.projectPath, candidates);
          if (!command) {
            logJev(`[codex:${tag}] No runnable tests map to the ${changed.length} changed project file(s); verification skipped.`);
            verificationSkipReason = candidates.length ? "JEV found related tests, but no supported local test runner was available." : "JEV found no existing tests directly related to the changed files.";
            return undefined;
          }
          const task = prepared.flatMap(job => job.tasks.map(item => item.description)).join("\n");
          let approved: boolean;
          try { approved = await this.verificationReviewer(task, changed, candidates); }
          catch (error) {
            logJevError(`[codex:${tag}] Targeted verification review unavailable: ${messageOf(error)}. Using affected tests only.`);
            approved = true;
          }
          if (!approved) { verificationSkipReason = "JEV determined that targeted tests were unnecessary for this change."; return undefined; }
          verificationSkipReason = undefined;
          approvedTests = candidates;
          logJev(`[codex:${tag}] JEV approved targeted tests: ${candidates.join(", ")}`);
          this.updateGroup(prepared, execution => ({ ...execution, events: [...execution.events, { id: randomUUID(), timestamp: new Date().toISOString(), kind: "system", title: "JEV approved targeted tests", detail: candidates.join(", "), status: "active" }] }));
          return command;
        };
        const verificationInstruction = (command: string) => `JEV approved only this targeted test command for files changed by this ticket: ${command}. Run this command once, and do not run any other tests, builds, dependency installation, or repository-wide checks. Do not change project files. Distinguish code failures from missing environment tools or dependencies. If checks fail because of code, end with JEV_VERIFICATION_FAILED. If the command passes, end with JEV_VERIFICATION_PASSED. If a missing environment dependency prevents it from running, report the blocker and end with JEV_VERIFICATION_ENVIRONMENT_BLOCKED. Do not claim success for checks that did not run.`;
        if (success) {
          const command = await chooseVerification();
          if (!command) {
            const checkedAt = new Date().toISOString();
            this.updateGroup(prepared, execution => ({ ...execution, metrics: execution.metrics ? { ...execution.metrics, stoppedAfterValidation: true } : execution.metrics, events: [...execution.events, { id: randomUUID(), timestamp: checkedAt, kind: "system", title: "JEV skipped tests", detail: verificationSkipReason, status: "success" }] }));
          } else {
            const checked = await runStage("verification", model, "low", verificationInstruction(command));
            const firstDecision = verificationDecision(verificationOutcome, verificationCommands);
            success = (checked.code === 0 && !checked.error && !stageTurnFailed) || (firstDecision.kind === "environment_blocked" && firstDecision.blockers.length > 0 && !checked.error);
            if (!success) failureMessage = checked.error ?? `Codex verification turn exited with code ${checked.code}`;
            if (success && (executedTests.size !== approvedTests.length || verificationOutOfScope)) {
              verification = "not_run";
              verificationSkipReason = verificationOutOfScope ? "Code completed, but Codex ran a verification command outside JEV's approved test scope." : "Code completed, but Codex did not run JEV's approved targeted tests.";
              logJev(`[codex:${tag}] Approved targeted tests were not run; no repair loop started.`);
              this.updateGroup(prepared, execution => ({ ...execution, events: [...execution.events, { id: randomUUID(), timestamp: new Date().toISOString(), kind: "system", title: "Targeted tests not run", detail: verificationSkipReason, status: "active" }] }));
            } else {
              let decision = verificationDecision(verificationOutcome, verificationCommands);
              const recordValidation = (result: typeof decision) => {
                const validatedAt = new Date().toISOString();
                if (result.kind === "environment_blocked") {
                  verification = "environment_blocked";
                  verificationBlockers = result.blockers;
                  logJev(`[codex:${tag}] Verification partially blocked by missing environment dependencies: ${result.blockers.join(", ") || "see Codex verification output"}`);
                }
                this.updateGroup(prepared, execution => ({ ...execution, metrics: execution.metrics ? { ...execution.metrics, stoppedAfterValidation: true } : execution.metrics, events: [...execution.events, { id: randomUUID(), timestamp: validatedAt, kind: "system", title: result.kind === "environment_blocked" ? "Verification partially blocked" : "Verification satisfied", detail: result.kind === "environment_blocked" ? `Missing environment dependencies: ${result.blockers.join(", ") || "see Codex verification output"}. Development completed; affected checks were not verified.` : "Validation passed; no further repair turn was started.", status: result.kind === "environment_blocked" ? "active" : "success" }] }));
              };
              if (success && decision.kind !== "failed") recordValidation(decision);
              for (let attempt = 0; success && decision.kind === "failed" && attempt < 2; attempt++) {
                const repairTier = attempt === 0 ? model : "sol";
                const repairEffort = attempt === 0 ? REASONING_LEVELS[Math.max(reasoningRank[reasoning], reasoningRank.high)] : "high";
                const repaired = await runStage("repair", repairTier, repairEffort, `The previous targeted verification found a real failing check. Diagnose the root cause and fix the current ticket${attempt ? ". A previous repair did not resolve it; reconsider the diagnosis and inspect the exact failing output." : "."} Check whether a missing tool or dependency explains a failure before changing application code. Inspect only changed files and direct dependencies. Preserve scope and update documentation if the fix changes it. Do not run tests; JEV will review the changed files again.`);
                success = repaired.code === 0 && !repaired.error && !stageTurnFailed && !reportedFailure;
                if (!success) { failureMessage = repaired.error ?? `Codex repair turn exited with code ${repaired.code}`; break; }
                const nextCommand = await chooseVerification();
                if (!nextCommand) {
                  decision = { kind: "passed", blockers: [] };
                  this.updateGroup(prepared, execution => ({ ...execution, events: [...execution.events, { id: randomUUID(), timestamp: new Date().toISOString(), kind: "system", title: "JEV skipped tests after repair", detail: verificationSkipReason, status: "active" }] }));
                  break;
                }
                const rechecked = await runStage("verification", repairTier, "low", verificationInstruction(nextCommand));
                const recheckDecision = verificationDecision(verificationOutcome, verificationCommands);
                success = (rechecked.code === 0 && !rechecked.error && !stageTurnFailed) || (recheckDecision.kind === "environment_blocked" && recheckDecision.blockers.length > 0 && !rechecked.error);
                if (!success) { failureMessage = rechecked.error ?? `Codex verification turn exited with code ${rechecked.code}`; break; }
                if (executedTests.size !== approvedTests.length || verificationOutOfScope) {
                  verification = "not_run";
                  verificationSkipReason = verificationOutOfScope ? "Code completed, but Codex ran a verification command outside JEV's approved test scope." : "Code completed, but Codex did not run JEV's approved targeted tests after repair.";
                  decision = { kind: "passed", blockers: [] };
                  break;
                }
                decision = verificationDecision(verificationOutcome, verificationCommands);
                if (decision.kind !== "failed") recordValidation(decision);
              }
              if (success && decision.kind === "failed") { success = false; failureMessage = "Verification checks still fail after two repair attempts"; }
            }
          }
        }
        const now = new Date().toISOString();
        const representative = this.queue.get(first.id)!; let compactedAfterTask = false; let compactionError: string | undefined;
        let codexStatus = await this.statusReader(representative.execution?.threadId).catch(error => ({ capturedAt: new Date().toISOString(), unavailableReason: messageOf(error) })) as CodexStatusSnapshot;
        if (representative.execution?.threadId) {
          const successesSinceCompaction = success ? this.queue.recordSuccessfulTasks(first.projectId, prepared.length) : this.queue.successesSinceCompaction(first.projectId);
          const contextTokens = codexStatus.context?.usedTokens;
          const compactForContext = contextTokens !== undefined && contextTokens >= 90_000;
          if (compactForContext) logJev(`[codex:${tag}] Context reached ${contextTokens} tokens; JEV requests /compact.`);
          if ((success && successesSinceCompaction >= 3) || compactForContext) {
            const reason = compactForContext ? `JEV measured ${contextTokens} context tokens (threshold: 90000).` : "Automatic compaction after three successful tasks.";
            process.stdout.write(`\x1b[33m[codex:${tag}] /compact START thread ${representative.execution.threadId}\x1b[0m\n`);
            this.updateGroup(prepared, execution => ({ ...execution, lastActivityAt: now, events: [...execution.events, { id: randomUUID(), timestamp: now, kind: "system", title: "Codex /compact started", detail: `Thread ${representative.execution!.threadId} — ${reason}`, status: "active" }] }));
            try { await this.compactor(representative.execution.threadId); compactedAfterTask = true; this.queue.markProjectCompacted(first.projectId); codexStatus = await this.statusReader(representative.execution.threadId).catch(() => codexStatus); } catch (error) { compactionError = messageOf(error); }
          }
        }
        const accountUsage = await this.accountUsageReader().catch(error => ({ capturedAt: new Date().toISOString(), unavailableReason: messageOf(error) }));
        if (compactedAfterTask) process.stdout.write(`\x1b[33m[codex:${tag}] /compact COMPLETED\x1b[0m\n`);
        if (compactionError) process.stderr.write(`\x1b[33m[codex:${tag}] /compact FAILED: ${compactionError}\x1b[0m\n`);
        const completed = prepared.map(job => {
          const latest = this.queue.get(job.id)!;
          const verificationNote = success && verification === "environment_blocked" ? `Code completed, but some tests or build checks could not run because required environment dependencies are missing${verificationBlockers.length ? `: ${verificationBlockers.join(", ")}` : ""}.` : success && verification === "not_run" ? verificationSkipReason : undefined;
          const checkpoint: ExecutionEvent = { id: randomUUID(), timestamp: now, kind: "system", title: "Codex status checkpoint", detail: JSON.stringify({ model: latest.execution?.model, reasoning: latest.execution?.reasoning, taskUsage: usage, accountUsage, codexStatus, verification, groupedTasks: prepared.length }), status: "success" };
          const compactEvents: ExecutionEvent[] = compactedAfterTask ? [{ id: randomUUID(), timestamp: now, kind: "system", title: "Codex /compact confirmed", detail: "Codex app-server confirmed JEV's automatic compaction.", status: "success" }] : compactionError ? [{ id: randomUUID(), timestamp: now, kind: "error", title: "Automatic compaction failed", detail: compactionError, status: "error" }] : [];
          return this.queue.transition(job.id, success ? "SUCCESS" : "FAILED", { output: rawOutput, error: success ? undefined : failureMessage, errorCategory: success ? (verification === "environment_blocked" ? "dependency" : verificationNote ? "verification" : undefined) : (stalled ? "interruption" : failureMessage.includes("Verification checks") ? "code" : reportedFailure ? "code" : "codex"), execution: { ...latest.execution!, phase: success ? "COMPLETED" : "ERROR", lastActivityAt: now, completedAt: now, usage, accountUsage, codexStatus, verificationNote, metrics: latest.execution!.metrics ? { ...latest.execution!.metrics, actualTokens: totalCodexTokens(usage) } : latest.execution!.metrics, verification, compactedAfterTask, events: [...latest.execution!.events, checkpoint, ...compactEvents, { id: randomUUID(), timestamp: now, kind: success ? "system" : "error", title: success ? "Execution completed" : "Execution failed", detail: success ? (verificationNote ?? (verification === "functional_verified" ? "Codex finished with functional verification." : verification === "tests_passed" ? "Codex finished and automated tests passed." : verification === "build_only" ? "Codex finished; compilation passed but functional behavior was not verified." : "Codex finished without a detected verification command.")) : failureMessage, status: success ? "success" : "error" }] } })!;
        });
        clearInterval(heartbeat);
        if (success) for (const job of completed) logTicketCompleted(tag, job.tasks[0]?.description ?? job.id);
        resolve(completed);
      });
    });
  }

  private updateGroup(jobs: Job[], mutate: (execution: NonNullable<Job["execution"]>) => NonNullable<Job["execution"]>) { for (const job of jobs) { const current = this.queue.get(job.id); if (current?.execution) this.queue.update(job.id, { execution: mutate(current.execution) }); } }
  private updateGroupOutput(jobs: Job[], output: string) { for (const job of jobs) this.queue.update(job.id, { output }); }
}
