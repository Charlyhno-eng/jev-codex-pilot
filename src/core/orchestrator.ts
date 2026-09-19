import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { analyze } from "./analyzer.js";
import { buildCodexCommand, buildCodexPrompt } from "./prompt.js";
import type { JobQueue } from "./queue.js";
import type { CodexUsage, ExecutionEvent, ExecutionPhase, Job } from "./types.js";

type JsonEvent = Record<string, unknown> & { type?: string; item?: Record<string, unknown> };

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 4000);
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value).slice(0, 4000);
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
    const child = spawn("codex", ["app-server", "--stdio"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(new Error("Codex compaction timed out")), 60_000);
    let settled = false;
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      error ? reject(error) : resolve();
    };
    lines.on("line", line => {
      let message: Record<string, any>;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 0 && message.error) return finish(new Error(message.error.message ?? "Could not initialize Codex app server"));
      if (message.id === 0 && message.result) {
        send({ method: "initialized", params: {} });
        send({ method: "thread/resume", id: 1, params: { threadId } });
      }
      if (message.id === 1 && message.result?.thread) send({ method: "thread/compact/start", id: 2, params: { threadId } });
      if (message.id === 1 && message.error) return finish(new Error(message.error.message ?? "Could not resume Codex thread"));
      if (message.id === 2 && message.error) return finish(new Error(message.error.message ?? "Could not compact Codex thread"));
      if (message.method === "item/completed" && message.params?.item?.type === "contextCompaction") finish();
      if (message.method === "turn/completed" && message.params?.turn?.status === "failed") finish(new Error("Codex compaction failed"));
    });
    child.on("error", finish);
    child.on("close", code => { if (!settled) finish(code === 0 ? undefined : new Error(`Codex app server exited with code ${code}`)); });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "jev_codex_pilot", title: "JEV Codex Pilot", version: "0.2.0" } } });
  });
}

export class Orchestrator {
  private runningBatches = new Set<string>();
  constructor(
    private queue: JobQueue,
    private analyzer = analyze,
    private compactor: (threadId: string) => Promise<void> = compactThread
  ) {}

  async prepare(job: Job) {
    if (!existsSync(job.projectPath)) throw new Error(`Project not found: ${job.projectPath}`);
    return this.queue.update(job.id, { analysis: await this.analyzer(job.projectPath, job.tasks) });
  }

  isBatchRunning(id: string) {
    const job = this.queue.get(id);
    return Boolean(job && this.runningBatches.has(job.batchId ?? job.id));
  }

  async command(job: Job) {
    const prepared = job.analysis ? job : (await this.prepare(job))!;
    return buildCodexCommand(prepared.tasks, prepared.analysis!);
  }

  async runBatch(id: string): Promise<void> {
    const first = this.queue.get(id);
    if (!first) throw new Error("Job not found");
    const batchId = first.batchId ?? first.id;
    if (this.runningBatches.has(batchId)) throw new Error("This task sequence is already running");
    this.runningBatches.add(batchId);
    try {
      const jobs = first.batchId ? this.queue.listBatch(first.batchId) : [first];
      for (const job of jobs) {
        if (job.status === "SUCCESS" || job.status === "SKIPPED") continue;
        try {
          await this.prepare(this.queue.get(job.id)!);
          await this.run(job.id);
        } catch (error) {
          // A single bad task must remain visible without preventing independent
          // tasks in the same batch from continuing.
          this.queue.transition(job.id, "FAILED", { error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally { this.runningBatches.delete(batchId); }
  }

  async run(id: string): Promise<Job> {
    const job = this.queue.get(id);
    if (!job) throw new Error("Job not found");
    if (job.status === "RUNNING") throw new Error("This job is already running");
    const prepared = job.analysis ? job : (await this.prepare(job))!;
    const analysis = prepared.analysis!;
    const prompt = buildCodexPrompt(prepared.tasks, analysis);
    const startedAt = new Date().toISOString();
    this.queue.transition(id, "RUNNING", {
      attempts: prepared.attempts + 1, output: "", error: undefined,
      execution: {
        phase: "STARTING", model: `gpt-5.6-${analysis.model}`, reasoning: analysis.reasoning,
        startedAt, lastActivityAt: startedAt, verification: "not_run",
        events: [{ id: randomUUID(), timestamp: startedAt, kind: "system", title: "Starting Codex", detail: prepared.projectPath, status: "active" }]
      }
    });

    return new Promise(resolve => {
      const previous = this.queue.list(prepared.projectId)
        .filter(candidate => candidate.id !== id && candidate.status === "SUCCESS" && candidate.execution?.threadId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const common = ["--json", "--skip-git-repo-check", "--model", `gpt-5.6-${analysis.model}`, "-c", `model_reasoning_effort=\"${analysis.reasoning}\"`];
      const args = previous?.execution?.threadId
        ? ["exec", "resume", ...common, previous.execution.threadId, prompt]
        : ["exec", ...common, "--color", "never", "--approve-for-me", prompt];
      const child = spawn("codex", args, { cwd: prepared.projectPath, shell: false });
      // `codex exec` appends piped stdin to the prompt. A spawned pipe stays open
      // unless we explicitly close it, which otherwise leaves Codex waiting forever.
      child.stdin.end();
      const launchedAt = new Date().toISOString();
      const commandSummary = `codex ${args.map(arg => arg === prompt ? "<task prompt>" : arg).join(" ")}`;
      process.stdout.write(`\x1b[36m[codex:${id.slice(0, 8)}] JEV SELECTED model=gpt-5.6-${analysis.model} reasoning=${analysis.reasoning}\x1b[0m\n`);
      process.stdout.write(`\x1b[36m[codex:${id.slice(0, 8)}] EXEC ${commandSummary}\x1b[0m\n`);
      const launched = this.queue.get(id)!;
      this.queue.update(id, { execution: { ...launched.execution!, pid: child.pid, lastActivityAt: launchedAt, events: [...launched.execution!.events, { id: randomUUID(), timestamp: launchedAt, kind: "system", title: "JEV selection applied", detail: `Model used: gpt-5.6-${analysis.model} · reasoning used: ${analysis.reasoning}`, status: "success" }, { id: randomUUID(), timestamp: launchedAt, kind: "command", title: "Codex command launched", detail: commandSummary, status: "success" }] } });
      let rawOutput = "";
      let stdoutBuffer = "";
      let settled = false;
      let reportedFailure = false;
      let usage: CodexUsage | undefined;
      let verification: "not_run" | "build_only" | "tests_passed" | "functional_verified" = "not_run";

      const record = (line: string) => {
        if (!line.trim()) return;
        if (/patch rejected|writing is blocked|impossible d['’]implémenter|could not implement|unable to implement/i.test(line)) reportedFailure = true;
        rawOutput = `${rawOutput}${line}\n`.slice(-250_000);
        if (/^Reading additional input from stdin\.\.\.$/i.test(line.trim())) {
          this.queue.update(id, { output: rawOutput });
          return;
        }
        let parsed: JsonEvent;
        try { parsed = JSON.parse(line) as JsonEvent; }
        catch { parsed = { type: "raw", message: line }; }
        const description = describe(parsed);
        if (parsed.type === "turn.completed" && parsed.usage && typeof parsed.usage === "object") usage = parsed.usage as CodexUsage;
        const item = parsed.item ?? {};
        if (parsed.type === "item.completed" && item.type === "command_execution" && item.exit_code === 0) {
          const command = String(item.command ?? "");
          if (/playwright|cypress|webdriver|browser/i.test(command)) verification = "functional_verified";
          else if (/\b(test|vitest|jest|pytest|cargo test|go test)\b/i.test(command) && verification !== "functional_verified") verification = "tests_passed";
          else if (/\b(build|tsc)\b/i.test(command) && verification === "not_run") verification = "build_only";
        }
        const current = this.queue.get(id)!;
        const now = new Date().toISOString();
        const events = [...(current.execution?.events ?? [])];
        if (description.item) events.push({ ...description.item, id: randomUUID(), timestamp: now });
        this.queue.update(id, {
          output: rawOutput,
          execution: { ...current.execution!, phase: description.phase, lastActivityAt: now, threadId: description.threadId ?? current.execution?.threadId, events: events.slice(-250) }
        });
      };

      child.stdout.on("data", chunk => {
        const value = chunk.toString();
        process.stdout.write(`[codex:${id.slice(0, 8)}] ${value}`);
        stdoutBuffer += value;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        lines.forEach(record);
      });
      child.stderr.on("data", chunk => {
        const value = chunk.toString();
        process.stderr.write(`[codex:${id.slice(0, 8)}] ${value}`);
        record(value.trim());
      });
      child.on("error", error => {
        if (settled) return; settled = true;
        const now = new Date().toISOString();
        const current = this.queue.get(id)!;
        resolve(this.queue.transition(id, "FAILED", {
          output: rawOutput, error: error.message,
          execution: { ...current.execution!, phase: "ERROR", lastActivityAt: now, completedAt: now, events: [...(current.execution?.events ?? []), { id: randomUUID(), timestamp: now, kind: "error", title: "Could not start Codex", detail: error.message, status: "error" }] }
        })!);
      });
      child.on("close", async code => {
        if (settled) return; settled = true;
        if (stdoutBuffer) record(stdoutBuffer);
        const now = new Date().toISOString();
        const current = this.queue.get(id)!;
        const success = code === 0 && !reportedFailure;
        const failureMessage = reportedFailure ? "Codex reported that it could not implement the task" : `Codex exited with code ${code}`;
        let compactedAfterTask = false;
        let compactionError: string | undefined;
        if (success && current.execution?.threadId) {
          const completedCount = this.queue.list(prepared.projectId).filter(candidate => candidate.id !== id && candidate.status === "SUCCESS").length + 1;
          if (completedCount % 3 === 0) {
            const compactionStartedAt = new Date().toISOString();
            process.stdout.write(`\x1b[35m[codex:${id.slice(0, 8)}] /compact START thread ${current.execution.threadId}\x1b[0m\n`);
            const compacting = this.queue.get(id)!;
            this.queue.update(id, { execution: { ...compacting.execution!, lastActivityAt: compactionStartedAt, events: [...compacting.execution!.events, { id: randomUUID(), timestamp: compactionStartedAt, kind: "system", title: "Codex /compact started", detail: `Thread ${current.execution.threadId} — automatic compaction after three successful tasks.`, status: "active" }] } });
            try { await this.compactor(current.execution.threadId); compactedAfterTask = true; }
            catch (error) { compactionError = error instanceof Error ? error.message : String(error); }
          }
        }
        const finalized = this.queue.get(id)!;
        if (compactedAfterTask) process.stdout.write(`\x1b[35m[codex:${id.slice(0, 8)}] /compact COMPLETED\x1b[0m\n`);
        if (compactionError) process.stderr.write(`\x1b[35m[codex:${id.slice(0, 8)}] /compact FAILED: ${compactionError}\x1b[0m\n`);
        const statusEvent: ExecutionEvent = { id: randomUUID(), timestamp: now, kind: "system", title: "Codex /status checkpoint", detail: JSON.stringify({ model: finalized.execution?.model, reasoning: finalized.execution?.reasoning, usage, verification }), status: "success" };
        const compactEvent: ExecutionEvent[] = compactedAfterTask
          ? [{ id: randomUUID(), timestamp: now, kind: "system", title: "Codex /compact confirmed", detail: "Codex app-server confirmed automatic compaction after exactly three successful tasks.", status: "success" }]
          : compactionError ? [{ id: randomUUID(), timestamp: now, kind: "error", title: "Automatic compaction failed", detail: compactionError, status: "error" }] : [];
        resolve(this.queue.transition(id, success ? "SUCCESS" : "FAILED", {
          output: rawOutput, error: success ? undefined : failureMessage,
          execution: { ...finalized.execution!, phase: success ? "COMPLETED" : "ERROR", lastActivityAt: now, completedAt: now, usage, verification, compactedAfterTask, events: [...(finalized.execution?.events ?? []), statusEvent, ...compactEvent, { id: randomUUID(), timestamp: now, kind: success ? "system" : "error", title: success ? "Execution completed" : "Execution failed", detail: success ? (verification === "functional_verified" ? "Codex finished with functional verification." : verification === "tests_passed" ? "Codex finished and automated tests passed." : verification === "build_only" ? "Codex finished; compilation passed but functional behavior was not verified." : "Codex finished without a detected verification command.") : failureMessage, status: success ? "success" : "error" }] }
        })!);
      });
    });
  }
}
