import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobQueue } from "../../src/core/queue.js";
import { codexModelId } from "../../src/core/codex-models.js";
import { isCompactionComplete, Orchestrator } from "../../src/core/orchestrator.js";
import { analyze } from "../../src/core/analyzer.js";
import type { Complexity, JevAnalysis, TaskType } from "../../src/core/types.js";

vi.mock("../../src/core/project-linter.js", async importOriginal => ({ ...await importOriginal<typeof import("../../src/core/project-linter.js")>(), ensureProjectLinterTicket: vi.fn(() => undefined) }));

vi.mock("../../src/core/codex-status.js", () => ({ readCodexStatusSnapshot: async () => ({ capturedAt: "2026-01-01T00:00:00.000Z", unavailableReason: "Unavailable in this test." }) }));

const originalPath = process.env.PATH;
const originalCodexHome = process.env.CODEX_HOME;
let testCodexHome = "";
beforeEach(() => { testCodexHome = mkdtempSync(join(tmpdir(), "jev-codex-home-")); process.env.CODEX_HOME = testCodexHome; });
afterEach(() => { process.env.PATH = originalPath; if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome; rmSync(testCodexHome, { recursive: true, force: true }); });

const analyzerFor = (taskType: TaskType, complexity: Complexity = 1) =>
  (projectPath: string, tasks: Array<{ description: string }>) => analyze(projectPath, tasks, async () => ({ taskType, complexity }));
const accountUsage = async () => ({ capturedAt: "2026-01-01T00:00:00.000Z", todayTokens: 42, lifetimeTokens: 420 });
describe("Codex orchestration", () => {
  it("releases the project slot when the project disappears during finalization", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-finalization-error-"));
    try {
      const project = join(root, "project");
      const bin = join(root, "bin");
      mkdirSync(project); mkdirSync(bin);
      writeFileSync(join(bin, "codex"), `#!/bin/sh
if [ "$1" != exec ]; then exit 0; fi
cd ..
rmdir project
printf '%s\\n' '{"type":"thread.started","thread_id":"missing-project-thread"}' '{"type":"turn.completed"}'
`);
      chmodSync(join(bin, "codex"), 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      const queue = new JobQueue(join(root, "queue"));
      const job = queue.create("project", project, [{ description: "Read project" }]);
      const analysis: JevAnalysis = { complexity: 5, model: "sol", reasoning: "high", task_types: ["research"], rationale: [], evaluator: "typesafe-ai/jev" };
      queue.update(job.id, { analysis });
      const orchestrator = new Orchestrator(queue, async () => analysis, undefined, accountUsage);
      const completed = await orchestrator.run(job.id);
      expect(completed.status).toBe("FAILED");
      expect(completed.execution?.events.some(event => event.title === "Execution finalization failed")).toBe(true);
      expect(orchestrator.isProjectRunning("project")).toBe(false);
      expect(orchestrator.ownsTicketRun(job.id)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rechecks continuity after editing a previously reviewed next ticket", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-continuity-edit-"));
    try {
      const project = join(root, "project");
      const bin = join(root, "bin");
      mkdirSync(project); mkdirSync(bin);
      writeFileSync(join(bin, "codex"), `#!/bin/sh
if [ "$1" != exec ]; then exit 0; fi
printf '%s\\n' '{"type":"thread.started","thread_id":"new-thread"}' '{"type":"turn.completed"}'
`);
      chmodSync(join(bin, "codex"), 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      const queue = new JobQueue(join(root, "queue"));
      const [previous, next] = queue.createBatch("project", project, [{ description: "Old work" }, { description: "Related request" }]);
      const now = new Date().toISOString();
      queue.transition(previous.id, "SUCCESS", { execution: { phase: "COMPLETED", model: "sol", reasoning: "high", startedAt: now, lastActivityAt: now, verification: "not_run", events: [], threadId: "old-thread", reviewedNextTaskId: next.id, reviewedNextTasks: JSON.stringify(next.tasks), reviewedNextContinuity: "related" } });
      queue.updatePendingTask(next.id, "Unrelated request");
      const analysis: JevAnalysis = { complexity: 1, model: "luna", reasoning: "medium", task_types: ["research"], rationale: [], evaluator: "typesafe-ai/jev" };
      queue.update(next.id, { analysis });
      const reviewer = vi.fn(async () => "unrelated" as const);
      const archiver = vi.fn(async () => undefined);
      const completed = await new Orchestrator(queue, async () => analysis, undefined, accountUsage, archiver, undefined, undefined, reviewer).run(next.id);
      expect(completed.status).toBe("SUCCESS");
      expect(reviewer).toHaveBeenCalledOnce();
      expect(reviewer).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ tasks: [{ description: "Unrelated request" }] }));
      expect(archiver).toHaveBeenCalledWith("old-thread", expect.any(String));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("records compaction failure when the app server exits without confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-unconfirmed-compaction-"));
    try {
      const project = join(root, "project");
      const bin = join(root, "bin");
      mkdirSync(project); mkdirSync(bin);
      writeFileSync(join(bin, "codex"), `#!/bin/sh
if [ "$1" != exec ]; then read ignored; exit 0; fi
printf '%s\\n' '{"type":"thread.started","thread_id":"unconfirmed-thread"}' '{"type":"turn.completed"}'
`);
      chmodSync(join(bin, "codex"), 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      const queue = new JobQueue(join(root, "queue"));
      const jobs = queue.createBatch("project", project, [{ description: "First" }, { description: "Next" }]);
      const analysis: JevAnalysis = { complexity: 1, model: "luna", reasoning: "medium", task_types: ["research"], rationale: [], evaluator: "typesafe-ai/jev" };
      jobs.forEach(job => queue.update(job.id, { analysis }));
      const status = async () => ({ capturedAt: new Date().toISOString(), context: { usedTokens: 100_000, windowTokens: 200_000 } });
      await new Orchestrator(queue, async () => analysis, undefined, accountUsage, undefined, undefined, status, async () => "related").runBatch(jobs[0].id);
      const completed = queue.get(jobs[0].id)!;
      expect(completed.status).toBe("SUCCESS");
      expect(completed.execution?.compactedAfterTask).toBe(false);
      expect(completed.execution?.events.some(event => event.title === "Automatic compaction failed")).toBe(true);
      expect(completed.execution?.events.some(event => event.title === "Codex /compact confirmed")).toBe(false);
      expect(queue.get(jobs[1].id)?.status).toBe("SUCCESS");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true])("runs a recovered escalation in Running and continues the queue (legacy recovery: %s)", async legacy => {
    const root = mkdtempSync(join(tmpdir(), "jev-escalation-recovery-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls");
    mkdirSync(project); mkdirSync(bin);
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh
if [ "$1" != exec ]; then exit 0; fi
printf '%s\\n' CALL_START "$@" >> '${calls}'
sleep 0.15
printf '%s\\n' '{"type":"thread.started","thread_id":"recovered-thread"}' '{"type":"turn.completed"}'
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const data = join(root, "queue");
    const queue = new JobQueue(data);
    const [job, next] = queue.createBatch("project", project, [{ description: "Inspect partial work" }, { description: "Inspect next task" }]);
    const analysis: JevAnalysis = { complexity: 1, task_types: ["research"], model: "sol", reasoning: "high", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    const now = new Date().toISOString();
    const oldOutput = JSON.stringify({ type: "error", message: "401 Unauthorized" });
    queue.transition(job.id, legacy ? "PENDING" : "ESCALATING", {
      analysis, attempts: 4, output: oldOutput,
      errorCategory: "interruption",
      recoveryNote: legacy ? "JEV was interrupted during model escalation. Review the partial work before resuming at the selected route." : undefined,
      execution: { phase: "QUEUED", model: codexModelId("sol"), reasoning: "high", startedAt: now, lastActivityAt: now, threadId: "interrupted-thread", escalationPending: true, verification: "not_run", events: [] }
    });
    queue.update(next.id, { analysis });
    queue.recoverInterrupted(() => false);
    const restored = new JobQueue(data);
    const orchestrator = new Orchestrator(restored, async () => analysis, async () => undefined, accountUsage, undefined, undefined, undefined, async () => "related");
    const running = orchestrator.runBatch(job.id);
    await vi.waitFor(() => expect(restored.get(job.id)).toMatchObject({ status: "RUNNING", attempts: 5 }));
    expect(restored.get(job.id)?.recoveryNote).toBeUndefined();
    await running;
    expect(restored.get(job.id)).toMatchObject({ status: "SUCCESS", attempts: 5, execution: { escalationPending: false } });
    expect(restored.get(job.id)?.output).toContain(oldOutput);
    expect(restored.get(next.id)?.status).toBe("SUCCESS");
    const invocations = readFileSync(calls, "utf8").split("CALL_START\n").slice(1);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toContain("resume\n");
    expect(invocations[0]).toContain("interrupted-thread\n");
    expect(invocations[0]).toContain(`${codexModelId("sol")}\n`);
    expect(invocations[0]).toContain('model_reasoning_effort="high"');
    expect(invocations[0]).toContain("Inspect the work already made");
  });

  it.each([
    "Implementation complete.",
    "Je ne peux pas l’implémenter dans ce tour : l’espace de travail est toujours en lecture seule. Aucun fichier n’a été modifié."
  ])("rejects an implementation with no project changes even with exit code zero: %s", async message => {
    const root = mkdtempSync(join(tmpdir(), "jev-empty-implementation-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "index.html"), "<html>cube</html>");
    const fakeCodex = join(bin, "codex");
    const events = [
      { type: "thread.started", thread_id: "blocked-thread" },
      { type: "item.completed", item: { type: "agent_message", text: message } },
      { type: "turn.completed" }
    ];
    writeFileSync(fakeCodex, `#!/bin/sh\n${events.map(event => `printf '%s\\n' '${JSON.stringify(event).replaceAll("'", "'\\''")}'`).join("\n")}\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project", project, [{ description: "Replace the cube with a 3D laboratory" }]);
    const analysis: JevAnalysis = { complexity: 3, task_types: ["feature"], model: "sol", reasoning: "medium", context_files: ["index.html"], files_to_modify: ["index.html"], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });
    const compactor = vi.fn(async () => undefined);
    const completed = await new Orchestrator(queue, async () => analysis, compactor, accountUsage, undefined, undefined, async () => ({ capturedAt: new Date().toISOString(), context: { usedTokens: 100_000, windowTokens: 200_000 } })).run(job.id);
    expect(completed.status).toBe("FAILED");
    expect(completed.error).toMatch(/No project file changes|could not implement/i);
    expect(compactor).not.toHaveBeenCalled();
    expect(readFileSync(join(project, "index.html"), "utf8")).toBe("<html>cube</html>");
  });

  it("passes write permissions before resume and detects changes in a non-Node project", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-writable-resume-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.jsonl");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "index.html"), "<html>cube</html>");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh
if [ "$1" != exec ]; then exit 0; fi
printf '%s\\n' CALL_START "$@" >> '${calls}'
if [ "$2" != --approve-for-me ]; then exit 2; fi
for arg in "$@"; do if [ "$arg" = --sandbox ]; then exit 2; fi; done
printf '<div>lab</div>' >> index.html
printf '%s\\n' '{"type":"thread.started","thread_id":"write-thread"}' '{"type":"turn.completed"}'
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const analysis: JevAnalysis = { complexity: 3, task_types: ["feature"], model: "sol", reasoning: "medium", context_files: ["index.html"], files_to_modify: ["index.html"], rationale: [], evaluator: "typesafe-ai/jev" };
    const orchestrator = new Orchestrator(queue, async () => analysis, async () => undefined, accountUsage, undefined, undefined, undefined, async () => "related");
    for (const description of ["Create the laboratory", "Animate the brain"]) {
      const job = queue.create("project", project, [{ description }]);
      queue.update(job.id, { analysis });
      expect((await orchestrator.run(job.id)).status).toBe("SUCCESS");
    }
    const invocations = readFileSync(calls, "utf8").split("CALL_START\n").slice(1).map(call => call.split("\n"));
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).not.toContain("resume");
    expect(invocations[1]).toContain("resume");
    expect(readFileSync(join(project, "index.html"), "utf8")).toBe("<html>cube</html><div>lab</div><div>lab</div>");
  });

  it("starts a fresh thread when earlier successful history shares a blocked thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-blocked-history-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const args = join(root, "args");
    mkdirSync(project); mkdirSync(bin);
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\nprintf '%s\\n' '{"type":"thread.started","thread_id":"fresh-thread"}' '{"type":"turn.completed"}'\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const data = join(root, "queue");
    const queue = new JobQueue(data);
    const now = new Date().toISOString();
    for (const output of ["Earlier completed task", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Je ne peux pas l’implémenter dans ce tour : l’espace de travail est toujours en lecture seule." } })]) {
      const old = queue.create("project", project, [{ description: "Previous task" }]);
      queue.transition(old.id, "SUCCESS", { output, execution: { phase: "COMPLETED", model: "gpt-6-sol", reasoning: "medium", startedAt: now, lastActivityAt: now, verification: "not_run", threadId: "old-thread", events: [] } });
    }
    const restored = new JobQueue(data);
    expect(restored.list("project").filter(job => job.status === "FAILED")).toHaveLength(1);
    const job = restored.create("project", project, [{ description: "Inspect project" }]);
    const analysis: JevAnalysis = { complexity: 1, task_types: ["research"], model: "luna", reasoning: "medium", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    restored.update(job.id, { analysis });
    const completed = await new Orchestrator(restored, async () => analysis, async () => undefined, accountUsage).run(job.id);
    expect(completed.status).toBe("SUCCESS");
    expect(readFileSync(args, "utf8").split("\n")).not.toContain("resume");
    expect(restored.list("project")).toHaveLength(3);
  });

  it("stops an active Codex run after repeated identical failed commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-loop-run-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "AGENTS.md"), "Use the project instructions.\n");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\nprintf '%s\\n' '{"type":"thread.started","thread_id":"loop-thread"}'\nfor count in 1 2 3; do printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","command":"cat missing.ts","aggregated_output":"missing","exit_code":1}}'; done\nprintf '%s\\n' '{"type":"turn.completed"}'\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Implement feature" }]);
    const analysis: JevAnalysis = { complexity: 1, task_types: ["feature"], model: "luna", reasoning: "low", context_files: ["AGENTS.md"], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });
    const completed = await new Orchestrator(queue, async () => analysis, async () => undefined, accountUsage).run(job.id);
    expect(completed.status).toBe("FAILED");
    expect(completed.errorCategory).toBe("loop");
    expect(completed.execution?.events.some(event => event.title === "Repetition loop detected")).toBe(true);
  });

  it("does not escalate or retry a loop failure after later work succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-loop-batch-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "AGENTS.md"), "Use the project instructions.\n");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\nif [ "$1" != "exec" ]; then exit 0; fi\nprintf 'run\\n' >> '${calls}'\ncase "$*" in\n  *"First task"*) for count in 1 2 3; do printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","command":"cat missing.ts","aggregated_output":"missing","exit_code":1}}'; done ;;\n  *) printf '%s\\n' '{"type":"thread.started","thread_id":"later-thread"}' '{"type":"turn.completed"}' ;;\nesac\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const jobs = queue.createBatch("project-1", project, [{ description: "First task" }, { description: "Later task" }]);
    for (const [index, job] of jobs.entries()) queue.update(job.id, { analysis: { complexity: 1, task_types: ["research"], model: index ? "sol" : "luna", reasoning: index ? "high" : "low", context_files: ["AGENTS.md"], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" } });
    await new Orchestrator(queue, analyzerFor("feature"), async () => undefined, accountUsage, undefined, undefined, undefined, async () => "unrelated").runBatch(jobs[0].id);
    expect(queue.get(jobs[0].id)).toMatchObject({ status: "FAILED", errorCategory: "loop", attempts: 1 });
    expect(queue.get(jobs[1].id)?.status).toBe("SUCCESS");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("stops a repeated implementation route before a third Codex turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-route-loop-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "AGENTS.md"), "Use the project instructions.\n");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\nif [ "$1" != "exec" ]; then exit 0; fi\nprintf 'run\\n' >> '${calls}'\nprintf '%s\\n' '{"type":"thread.started","thread_id":"route-loop-thread"}' '{"type":"item.completed","item":{"type":"agent_message","text":"Continue.\\nJEV_ROUTE=sol:high"}}' '{"type":"turn.completed"}'\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Implement feature" }]);
    const analysis: JevAnalysis = { complexity: 2, task_types: ["research"], model: "luna", reasoning: "medium", context_files: ["AGENTS.md"], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });
    const completed = await new Orchestrator(queue, async () => analysis, async () => undefined, accountUsage).run(job.id);
    expect(completed).toMatchObject({ status: "FAILED", errorCategory: "loop" });
    expect(completed.execution?.metrics?.turns).toBe(2);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("rejects simultaneous launches for different tickets in one project", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-project-lock-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "package.json"), "{}");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, "#!/bin/sh\ncat >/dev/null\nsleep 0.1\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"locked-thread\"}' '{\"type\":\"turn.completed\"}'\n");
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const first = queue.create("project-1", project, [{ description: "First change" }]);
    const second = queue.create("project-1", project, [{ description: "Second change" }]);
    const orchestrator = new Orchestrator(queue, analyzerFor("research"), async () => undefined, accountUsage, undefined, undefined, undefined, async () => "uncertain");
    const running = orchestrator.run(first.id);
    await expect(orchestrator.run(second.id)).rejects.toThrow("already running for this project");
    expect((await running).status).toBe("SUCCESS");
    expect(queue.get(second.id)?.status).toBe("PENDING");
  });
  it("runs independent project batches concurrently in separate Codex homes", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-project-fairness-"));
    const bin = join(root, "bin");
    const firstProject = join(root, "first");
    const secondProject = join(root, "second");
    const calls = join(root, "calls");
    mkdirSync(bin); mkdirSync(firstProject); mkdirSync(secondProject);
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh
if [ "$1" != exec ]; then exit 0; fi
project="$(basename "$PWD")"
printf 'start:%s:%s:%s\\n' "$project" "$CODEX_HOME" "$CODEX_SQLITE_HOME" >> '${calls}'
sleep 0.12
printf 'end:%s\\n' "$project" >> '${calls}'
printf '{"type":"thread.started","thread_id":"%s-thread"}\\n' "$project"
printf '%s\\n' '{"type":"turn.completed"}'
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const first = queue.createBatch("first", firstProject, [{ description: "First A" }, { description: "Second A" }]);
    const second = queue.createBatch("second", secondProject, [{ description: "First B" }, { description: "Second B" }]);
    const orchestrator = new Orchestrator(queue, analyzerFor("research"), async () => undefined, accountUsage, undefined, undefined, undefined, async () => "related");
    await Promise.all([orchestrator.runBatch(first[0].id), orchestrator.runBatch(second[0].id)]);
    expect([...first, ...second].map(job => queue.get(job.id)?.status)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS"]);
    expect(first.map(job => queue.get(job.id)?.execution?.threadId)).toEqual(["first-thread", "first-thread"]);
    expect(second.map(job => queue.get(job.id)?.execution?.threadId)).toEqual(["second-thread", "second-thread"]);
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    expect(lines.slice(0, 2).map(line => line.split(":")[0])).toEqual(["start", "start"]);
    expect(new Set(lines.slice(0, 2).map(line => line.split(":")[1]))).toEqual(new Set(["first", "second"]));
    const starts = lines.filter(line => line.startsWith("start:")).map(line => line.split(":"));
    expect(starts).toHaveLength(4);
    expect(new Set(starts.filter(([, project]) => project === "first").map(([, , home]) => home)).size).toBe(1);
    expect(new Set(starts.filter(([, project]) => project === "second").map(([, , home]) => home)).size).toBe(1);
    expect(new Set(starts.map(([, , home]) => home)).size).toBe(2);
    expect(starts.every(([, , home, sqliteHome]) => home === sqliteHome)).toBe(true);
  });
  it("reuses an analysis already attached to a newly created ticket", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-prepared-ticket-"));
    const project = join(root, "project");
    mkdirSync(project);
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Keep this recommendation" }]);
    const analysis: JevAnalysis = { complexity: 1, outcome_clarity_score: 75, task_types: ["feature"], model: "luna", reasoning: "medium", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });
    let evaluations = 0;
    const orchestrator = new Orchestrator(queue, async () => { evaluations += 1; return analysis; }, async () => undefined, accountUsage);

    const prepared = await orchestrator.prepare(queue.get(job.id)!);

    expect(prepared.analysis).toBe(analysis);
    expect(evaluations).toBe(0);
  });

  it("executes a ticket submitted while the previous ticket is running", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-live-arrival-"));
    try {
      const project = join(root, "project");
      const bin = join(root, "bin");
      mkdirSync(project); mkdirSync(bin);
      const fakeCodex = join(bin, "codex");
      writeFileSync(fakeCodex, `#!/bin/sh
if [ "$1" != exec ]; then exit 0; fi
sleep 0.15
printf '%s\\n' '{"type":"thread.started","thread_id":"arrival-thread"}' '{"type":"turn.completed"}'
`);
      chmodSync(fakeCodex, 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      const queue = new JobQueue(join(root, "queue"));
      const first = queue.create("project", project, [{ description: "Read first document" }]);
      const evaluator = vi.fn(analyzerFor("research"));
      const orchestrator = new Orchestrator(queue, evaluator, async () => undefined, accountUsage, async () => undefined, undefined, undefined, async () => "unrelated");
      const running = orchestrator.runBatch(first.id);
      await vi.waitFor(() => expect(queue.get(first.id)?.status).toBe("RUNNING"));
      const next = queue.createBatch("project", project, [{ description: "Read another document" }])[0];
      await orchestrator.prepare(next);
      await running;
      expect(queue.get(first.id)?.status).toBe("SUCCESS");
      expect(queue.get(next.id)?.status).toBe("SUCCESS");
      expect(evaluator).toHaveBeenCalledTimes(2);
      expect(orchestrator.isProjectRunning("project")).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("shares concurrent evaluations and preserves a manual recommendation", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-concurrent-evaluation-"));
    try {
      const queue = new JobQueue(join(root, "queue"));
      const job = queue.create("project", root, [{ description: "Read the documentation" }]);
      const analysis: JevAnalysis = { complexity: 1, task_types: ["documentation"], model: "luna", reasoning: "medium", rationale: [], evaluator: "typesafe-ai/jev" };
      let finish!: (value: JevAnalysis) => void;
      const evaluator = vi.fn(() => new Promise<JevAnalysis>(resolve => { finish = resolve; }));
      const orchestrator = new Orchestrator(queue, evaluator);
      const first = orchestrator.prepare(job);
      const second = orchestrator.prepare(job);
      expect(evaluator).toHaveBeenCalledTimes(1);
      queue.update(job.id, { analysis: { ...analysis, model: "sol", reasoning: "high" } });
      finish(analysis);
      await Promise.all([first, second]);
      expect(queue.get(job.id)?.analysis).toMatchObject({ model: "sol", reasoning: "high" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("bounds a stalled evaluation and permits another evaluation after failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-evaluation-timeout-"));
    vi.useFakeTimers();
    try {
      const queue = new JobQueue(join(root, "queue"));
      const job = queue.create("project", root, [{ description: "Read the documentation" }]);
      const analysis: JevAnalysis = { complexity: 1, task_types: ["documentation"], model: "luna", reasoning: "medium", rationale: [], evaluator: "typesafe-ai/jev" };
      const evaluator = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(analysis);
      const orchestrator = new Orchestrator(queue, evaluator);
      const failed = expect(orchestrator.prepare(job)).rejects.toThrow("timed out after 60 seconds");
      await vi.advanceTimersByTimeAsync(60_000);
      await failed;
      expect(queue.get(job.id)?.errorCategory).toBe("jev");
      await orchestrator.prepare(job);
      expect(queue.get(job.id)?.analysis).toEqual(analysis);
      expect(queue.get(job.id)?.error).toBeUndefined();
    } finally { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
  });

  it("ignores an obsolete evaluation after the pending description changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-edited-evaluation-"));
    try {
      const queue = new JobQueue(join(root, "queue"));
      const job = queue.create("project", root, [{ description: "Original request" }]);
      const oldAnalysis: JevAnalysis = { complexity: 1, task_types: ["documentation"], model: "luna", reasoning: "medium", rationale: [], evaluator: "typesafe-ai/jev" };
      const newAnalysis: JevAnalysis = { ...oldAnalysis, complexity: 4, model: "sol" };
      let finish!: (value: JevAnalysis) => void;
      const evaluator = vi.fn().mockImplementationOnce(() => new Promise<JevAnalysis>(resolve => { finish = resolve; })).mockResolvedValue(newAnalysis);
      const orchestrator = new Orchestrator(queue, evaluator);
      const original = orchestrator.prepare(job);
      queue.updatePendingTask(job.id, "Updated request");
      await orchestrator.prepare(queue.get(job.id)!);
      finish(oldAnalysis);
      await original;
      expect(queue.get(job.id)?.analysis).toEqual(newAnalysis);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("recognizes the current app-server context-compaction completion notification", () => {
    expect(isCompactionComplete({ method: "item/completed", params: { item: { type: "contextCompaction" } } })).toBe(true);
    expect(isCompactionComplete({ method: "item.started", params: { item: { type: "contextCompaction" } } })).toBe(false);
  });

  it("closes stdin and streams JSONL until the child exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-run-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const args = join(root, "args.log");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "package.json"), "{}");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${args}'\ncat >/dev/null\nprintf '\\n' >> package.json\nprintf '%s\\n' '{"type":"thread.started","thread_id":"test-thread"}' '{"type":"turn.started"}' '{"type":"turn.completed"}'\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Install dependencies" }]);
    const image = join(root, "reference.png");
    writeFileSync(image, "visual reference");
    queue.update(job.id, { attachments: [{ id: "reference", name: "reference.png", mimeType: "image/png", size: 16, path: image }] });
    const compactor = vi.fn(async () => undefined);
    const orchestrator = new Orchestrator(queue, analyzerFor("installation"), compactor, accountUsage, undefined, undefined, async () => ({ capturedAt: "2026-09-22T00:00:00.000Z", context: { usedTokens: 90_900, windowTokens: 258_000 }, fiveHour: { remainingPercent: 81 }, weekly: { remainingPercent: 29 } }));
    await orchestrator.prepare(job);
    const completed = await orchestrator.run(job.id);

    expect(completed.status).toBe("SUCCESS");
    expect(completed.execution?.threadId).toBe("test-thread");
    expect(completed.execution?.phase).toBe("COMPLETED");
    expect(completed.execution?.codexStatus?.context).toEqual({ usedTokens: 90_900, windowTokens: 258_000 });
    expect(completed.output).toContain("turn.completed");
    expect(completed.execution?.events.some(event => event.title === "Codex command launched")).toBe(true);
    expect(readFileSync(args, "utf8")).toContain("--approve-for-me");
    expect(readFileSync(args, "utf8")).not.toContain("--sandbox");
    expect(readFileSync(args, "utf8")).toContain("--model");
    expect(readFileSync(args, "utf8")).toContain(codexModelId("luna"));
    expect(readFileSync(args, "utf8")).toContain('model_reasoning_effort="medium"');
    expect(completed.execution?.compactedAfterTask).toBe(false);
    expect(compactor).not.toHaveBeenCalled();
    expect(completed.execution?.events.some(event => event.title === "Codex /compact started")).toBe(false);
    expect(readFileSync(args, "utf8")).toContain("--image");
    expect(readFileSync(args, "utf8")).toContain(image);
    const invocation = readFileSync(args, "utf8").split("\n");
    expect(invocation[invocation.indexOf("--image") + 1]).toBe(image);
    expect(invocation[invocation.indexOf("--image") + 2]).toBe("--");
    expect(invocation[invocation.indexOf("--") + 1]).toContain("You are executing one task");
  }, 3000);

  it("pauses a ticket when Codex reaches its session limit and resumes it after reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-session-limit-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "package.json"), "{}");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{"type":"thread.started","thread_id":"paused-thread"}' '{"type":"error","message":"You’ve hit your usage limit. Try again at Sep 26th, 2099 3:17 PM."}' '{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Try again at Sep 26th, 2099 3:17 PM."}}'\nexit 1\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Resume after the quota reset" }]);
    let statusReads = 0;
    const rateLimits = async () => { statusReads++; return { available: false, reached: false }; };
    const orchestrator = new Orchestrator(queue, analyzerFor("research"), async () => undefined, accountUsage, undefined, rateLimits);
    await orchestrator.prepare(job);

    const paused = await orchestrator.run(job.id);
    expect(paused.status).toBe("SESSION_PAUSED");
    expect(paused.execution?.events.some(event => event.title === "Codex session limit reached")).toBe(true);
    expect(paused.execution?.threadId).toBe("paused-thread");
    expect(paused.sessionResumeAt).toBe(new Date(Date.parse("Sep 26, 2099 3:17 PM") + 60_000).toISOString());
    expect(statusReads).toBe(1);
    expect(await orchestrator.resumeSessionPausedJobs()).toHaveLength(0);
    expect(queue.get(job.id)?.status).toBe("SESSION_PAUSED");

    queue.update(job.id, { sessionResumeAt: new Date(Date.now() - 1_000).toISOString() });
    const resumed = await orchestrator.resumeSessionPausedJobs();
    expect(resumed).toHaveLength(1);
    expect(queue.get(job.id)?.status).toBe("PENDING");
    expect(queue.get(job.id)?.execution?.events.some(event => event.title === "Codex session available")).toBe(true);
    const argsFile = join(root, "resume-args");
    writeFileSync(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat >/dev/null\nprintf '%s\\n' '{"type":"thread.started","thread_id":"paused-thread"}' '{"type":"turn.completed"}'\n`);
    expect((await orchestrator.run(job.id)).status).toBe("SUCCESS");
    expect(readFileSync(argsFile, "utf8")).toContain("resume\n");
    expect(readFileSync(argsFile, "utf8")).toContain("paused-thread\n");
  }, 3000);

  it("honors a bounded implementation route requested by Codex", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-requested-route-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    const counter = join(root, "counter");
    mkdirSync(project); mkdirSync(bin);
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh
cat >/dev/null
count=$(cat '${counter}' 2>/dev/null || echo 0)
count=$((count + 1))
printf '%s' "$count" > '${counter}'
for arg in "$@"; do
  case "$arg" in exec|resume|gpt-*|model_reasoning_effort=*|requested-thread) printf '%s ' "$arg" >> '${calls}' ;; esac
done
printf '\\n' >> '${calls}'
printf '%s\\n' '{"type":"thread.started","thread_id":"requested-thread"}'
if [ "$count" = 1 ]; then
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Need a harder implementation step.\\nJEV_ROUTE=sol:high"}}'
fi
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":3}}'
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Implement a tricky change" }]);
    const analysis: JevAnalysis = { complexity: 2, task_types: ["research"], model: "luna", reasoning: "medium", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });
    const completed = await new Orchestrator(queue, async () => analysis, async () => undefined, accountUsage).run(job.id);
    const invocations = readFileSync(calls, "utf8").trim().split("\n");

    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toContain(codexModelId("luna"));
    expect(invocations[1]).toContain(codexModelId("luna"));
    expect(invocations[1]).toContain('model_reasoning_effort="high"');
    expect(completed.status).toBe("SUCCESS");
    expect(completed.execution?.usage?.input_tokens).toBe(6);
  }, 3000);

  it("runs each queued ticket separately and defers compaction until a related next ticket is known", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-batch-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "package.json"), "{}");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\ncat >/dev/null\nprintf 'run\\n' >> '${calls}'\nprintf '\\n' >> package.json\nprintf '%s\\n' '{"type":"thread.started","thread_id":"batch-thread"}' '{"type":"turn.completed"}'\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    const queue = new JobQueue(join(root, "queue"));
    const jobs = queue.createBatch("project-1", project, [
      { description: "Install dependencies" },
      { description: "Design the game screen" },
      { description: "Add game tests" }
    ]);
    const decisions = ["installation", "ui_ux", "testing"] as const;
    let decision = 0;
    const orchestrator = new Orchestrator(
      queue,
      (projectPath, tasks) => analyze(projectPath, tasks, async () => ({ taskType: decisions[decision++], complexity: 1 })),
      async () => undefined,
      accountUsage, undefined, undefined, undefined, async () => "related"
    );
    await orchestrator.runBatch(jobs[0].id);

    expect(queue.listBatch(jobs[0].batchId!).map(job => job.status)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(3);
    expect(queue.listBatch(jobs[0].batchId!)[0].analysis?.model).toBe("luna");
    expect(queue.listBatch(jobs[0].batchId!)[1].analysis?.model).toBe("luna");
    expect(queue.listBatch(jobs[0].batchId!)[2].execution?.events.some(event => event.title === "Codex /compact started")).toBe(false);
  }, 3000);

  it("continues the ticket sequence after an individual ticket fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-failure-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "main.ts"), "export {};");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\ncat >/dev/null\nprintf 'run\\n' >> '${calls}'\nprintf '%s\\n' '2026-01-01 ERROR patch rejected: writing is blocked by read-only sandbox' >&2\nexit 0\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    const queue = new JobQueue(join(root, "queue"));
    const jobs = queue.createBatch("project-1", project, [
      { description: "First change" },
      { description: "Tests that depend on the change" }
    ]);
    await new Orchestrator(queue, analyzerFor("feature"), async () => undefined, accountUsage, undefined, undefined, undefined, async () => "related").runBatch(jobs[0].id);

    expect(queue.listBatch(jobs[0].batchId!).map(job => job.status)).toEqual(["FAILED", "FAILED"]);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(10);
  }, 3000);

  it("retries an earlier failed task once after a later task succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-retry-batch-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    const counter = join(root, "counter");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "main.ts"), "export {};");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\ncat >/dev/null\ncount=$(cat '${counter}' 2>/dev/null || echo 0)\ncount=$((count + 1))\nprintf '%s' "$count" > '${counter}'\nprintf 'run\\n' >> '${calls}'\nif [ "$count" = 1 ]; then\n  printf '%s\\n' '2026-01-01 ERROR patch rejected: writing is blocked by read-only sandbox' >&2\nelse\n  printf '%s\\n' '{"type":"thread.started","thread_id":"retry-thread"}' '{"type":"turn.completed"}'\n  printf '// task change\\n' >> main.ts\nfi\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    const queue = new JobQueue(join(root, "queue"));
    const jobs = queue.createBatch("project-1", project, [
      { description: "First change" },
      { description: "Independent follow-up" }
    ]);
    const decisions = [
      { model: "luna", reasoning: "low" },
      { model: "sol", reasoning: "high" }
    ] as const;
    let index = 0;
    await new Orchestrator(queue, async () => ({
      complexity: 1, task_types: ["feature"],       ...decisions[index++], context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev"
    }), async () => undefined, accountUsage, undefined, undefined, undefined, async () => "related").runBatch(jobs[0].id);

    const result = queue.listBatch(jobs[0].batchId!);
    expect(result.map(job => job.status)).toEqual(["SUCCESS", "SUCCESS"]);
    expect(result[0].attempts).toBe(2);
    expect(result[1].attempts).toBe(1);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(3);
  }, 3000);

  it("runs tickets separately when their reasoning settings differ", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-reasoning-separate-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "package.json"), "{}");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\ncat >/dev/null\nprintf 'run\\n' >> '${calls}'\nprintf '%s\\n' '{"type":"thread.started","thread_id":"group-thread"}' '{"type":"turn.completed","usage":{"input_tokens":7}}'\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const jobs = queue.createBatch("project-1", project, [{ description: "First small change" }, { description: "Second small change" }, { description: "Third focused change" }]);
    const decisions = [
      { complexity: 1, model: "luna", reasoning: "medium" },
      { complexity: 2, model: "luna", reasoning: "high" },
      { complexity: 3, model: "luna", reasoning: "max" }
    ] as const;
    let index = 0;
    await new Orchestrator(queue, async () => ({
      task_types: ["research"], ...decisions[index++], context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev"
    }), async () => undefined, accountUsage, undefined, undefined, undefined, async () => "related").runBatch(jobs[0].id);

    const result = queue.listBatch(jobs[0].batchId!);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(3);
    expect(result.map(job => job.status)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
    expect(result.map(job => job.execution?.reasoning)).toEqual(["medium", "high", "max"]);
    expect(result[2].execution?.reasoning).toBe("max");
  }, 3000);

  it("clears an unrelated completed thread before the next ticket", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-auto-clear-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(bin, "codex"), "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"unrelated-thread\"}' '{\"type\":\"turn.completed\"}'\n");
    chmodSync(join(bin, "codex"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const completed = queue.create("project-1", project, [{ description: "Add a login screen" }]);
    const next = queue.create("project-1", project, [{ description: "Optimize the image loader" }]);
    const compactor = vi.fn(async () => undefined);
    const archiver = vi.fn(async () => undefined);
    const continuity = vi.fn(async () => "unrelated" as const);
    const orchestrator = new Orchestrator(queue, analyzerFor("research"), compactor, accountUsage, archiver, undefined, async () => ({ capturedAt: new Date().toISOString(), context: { usedTokens: 120_000, windowTokens: 258_000 } }), continuity);
    expect((await orchestrator.run(completed.id)).status).toBe("SUCCESS");
    expect(continuity).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: completed.id })]), expect.objectContaining({ id: next.id }));
    expect(archiver).toHaveBeenCalledWith("unrelated-thread", expect.any(String));
    expect(compactor).not.toHaveBeenCalled();
    expect(queue.get(completed.id)?.execution?.threadArchivedAt).toBeTruthy();
    expect(queue.get(next.id)?.status).toBe("PENDING");
  }, 3000);

  it("runs separate tickets separately and clears unrelated context", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-unrelated-batch-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const counter = join(root, "counter");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(bin, "codex"), `#!/bin/sh
cat >/dev/null
count=$(cat '${counter}' 2>/dev/null || echo 0)
count=$((count + 1))
printf '%s' "$count" > '${counter}'
printf '{"type":"thread.started","thread_id":"thread-%s"}\n' "$count"
printf '%s\n' '{"type":"turn.completed"}'
`);
    chmodSync(join(bin, "codex"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const jobs = queue.createBatch("project-1", project, [{ description: "Add a login screen" }, { description: "Optimize the image loader" }]);
    const archiver = vi.fn(async () => undefined);
    const continuity = vi.fn(async () => "unrelated" as const);
    const orchestrator = new Orchestrator(queue, analyzerFor("research"), async () => undefined, accountUsage, archiver, undefined, undefined, continuity);
    await orchestrator.runBatch(jobs[0].id);
    expect(readFileSync(counter, "utf8")).toBe("2");
    expect(queue.listBatch(jobs[0].batchId!).map(job => job.status)).toEqual(["SUCCESS", "SUCCESS"]);
    expect(queue.get(jobs[0].id)?.execution?.threadId).toBe("thread-1");
    expect(continuity).toHaveBeenCalledTimes(1);
    expect(archiver).toHaveBeenCalledWith("thread-1", expect.any(String));
    expect(queue.get(jobs[1].id)?.execution?.threadId).toBe("thread-2");
  }, 3000);

  it("continues the queue with a related thread after compaction at 100,000 context tokens", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-related-compact-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(bin, "codex"), "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"related-thread\"}' '{\"type\":\"turn.completed\"}'\n");
    chmodSync(join(bin, "codex"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const completed = queue.create("project-1", project, [{ description: "Add a login screen" }]);
    const next = queue.create("project-1", project, [{ description: "Add validation to the login screen" }]);
    const compactor = vi.fn(async () => undefined);
    const archiver = vi.fn(async () => undefined);
    const orchestrator = new Orchestrator(queue, analyzerFor("research"), compactor, accountUsage, archiver, undefined, async () => ({ capturedAt: new Date().toISOString(), context: { usedTokens: 100_000, windowTokens: 258_000 } }), async () => "related");
    await orchestrator.runBatch(completed.id);
    expect(queue.get(completed.id)?.status).toBe("SUCCESS");
    expect(queue.get(next.id)?.status).toBe("SUCCESS");
    expect(compactor).toHaveBeenCalledWith("related-thread", expect.any(String));
    expect(compactor).toHaveBeenCalledTimes(1);
    expect(archiver).not.toHaveBeenCalled();
  }, 3000);
});


describe("Git action project reservation", () => {
  it("blocks overlapping work, permits other projects, and releases failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-git-action-lock-"));
    try {
      const orchestrator = new Orchestrator(new JobQueue(root));
      let release!: () => void;
      const action = orchestrator.withProjectGitAction("project", () => new Promise<void>(resolve => { release = resolve; }));
      expect(orchestrator.isProjectRunning("project")).toBe(true);
      expect(orchestrator.isProjectGitActionRunning("project")).toBe(true);
      expect(orchestrator.ownsProjectRun("project")).toBe(false);
      await expect(orchestrator.withProjectGitAction("project", async () => {})).rejects.toThrow("already running");
      await expect(orchestrator.withProjectGitAction("other", async () => "done")).resolves.toBe("done");
      release(); await action;
      expect(orchestrator.isProjectRunning("project")).toBe(false);
      expect(orchestrator.isProjectGitActionRunning("project")).toBe(false);
      await expect(orchestrator.withProjectGitAction("project", async () => { throw new Error("Push failed"); })).rejects.toThrow("Push failed");
      expect(orchestrator.isProjectRunning("project")).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
