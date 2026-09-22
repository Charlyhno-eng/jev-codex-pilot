import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobQueue } from "../../src/core/queue.js";
import { isCompactionComplete, Orchestrator } from "../../src/core/orchestrator.js";
import { analyze } from "../../src/core/analyzer.js";
import type { Complexity, JevAnalysis, TaskType } from "../../src/core/types.js";

vi.mock("../../src/core/codex-status.js", () => ({ readCodexStatusSnapshot: async () => ({ capturedAt: "2026-01-01T00:00:00.000Z", unavailableReason: "Unavailable in this test." }) }));

const originalPath = process.env.PATH;
afterEach(() => { process.env.PATH = originalPath; });

const analyzerFor = (taskType: TaskType, complexity: Complexity = "low") =>
  (projectPath: string, tasks: Array<{ description: string }>) => analyze(projectPath, tasks, async () => ({ taskType, complexity }));
const accountUsage = async () => ({ capturedAt: "2026-01-01T00:00:00.000Z", todayTokens: 42, lifetimeTokens: 420 });
function prepareTargetedProject(project: string) {
  mkdirSync(join(project, "src"));
  mkdirSync(join(project, "tests"));
  mkdirSync(join(project, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ devDependencies: { vitest: "1.0.0" } }));
  writeFileSync(join(project, "src", "feature.ts"), "export const feature = true;\n");
  writeFileSync(join(project, "tests", "feature.test.ts"), "test('feature', () => {});\n");
  writeFileSync(join(project, "node_modules", ".bin", "vitest"), "#!/bin/sh\nexit 0\n");
}

describe("Codex orchestration", () => {
  it("reuses an analysis already attached to a newly created ticket", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-prepared-ticket-"));
    const project = join(root, "project");
    mkdirSync(project);
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Keep this recommendation" }]);
    const analysis: JevAnalysis = { complexity: "low", precision_score: 75, decomposition_score: 100, task_types: ["feature"], model: "luna", reasoning: "medium", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });
    let evaluations = 0;
    const orchestrator = new Orchestrator(queue, async () => { evaluations += 1; return analysis; }, async () => undefined, accountUsage);

    const prepared = await orchestrator.prepare(queue.get(job.id)!);

    expect(prepared.analysis).toBe(analysis);
    expect(evaluations).toBe(0);
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
    writeFileSync(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${args}'\ncat >/dev/null\nprintf '%s\\n' '{"type":"thread.started","thread_id":"test-thread"}' '{"type":"turn.started"}' '{"type":"turn.completed"}'\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Install dependencies" }]);
    const image = join(root, "reference.png");
    writeFileSync(image, "visual reference");
    queue.update(job.id, { attachments: [{ id: "reference", name: "reference.png", mimeType: "image/png", size: 16, path: image }] });
    const orchestrator = new Orchestrator(queue, analyzerFor("installation"), async () => undefined, accountUsage, undefined, undefined, async () => ({ capturedAt: "2026-09-22T00:00:00.000Z", context: { usedTokens: 90_900, windowTokens: 258_000 }, fiveHour: { remainingPercent: 81 }, weekly: { remainingPercent: 29 } }));
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
    expect(readFileSync(args, "utf8")).toContain("gpt-5.6-luna");
    expect(readFileSync(args, "utf8")).toContain('model_reasoning_effort="medium"');
    expect(completed.execution?.compactedAfterTask).toBe(true);
    expect(completed.execution?.events.some(event => event.title === "Codex /compact started" && event.detail?.includes("90000"))).toBe(true);
    expect(readFileSync(args, "utf8")).toContain("--image");
    expect(readFileSync(args, "utf8")).toContain(image);
  }, 3000);

  it("pauses a ticket when Codex reaches its session limit and resumes it after reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-session-limit-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "package.json"), "{}");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{"type":"error","message":"You have reached your 5-hour session limit."}'\nexit 1\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Resume after the quota reset" }]);
    let reached = true;
    const rateLimits = async () => ({ available: true, reached, resetsAt: "2026-01-01T00:00:00.000Z" });
    const orchestrator = new Orchestrator(queue, analyzerFor("feature"), async () => undefined, accountUsage, undefined, rateLimits);
    await orchestrator.prepare(job);

    const paused = await orchestrator.run(job.id);
    expect(paused.status).toBe("SESSION_PAUSED");
    expect(paused.execution?.events.some(event => event.title === "Codex session limit reached")).toBe(true);

    reached = false;
    const resumed = await orchestrator.resumeSessionPausedJobs();
    expect(resumed).toHaveLength(1);
    expect(queue.get(job.id)?.status).toBe("PENDING");
    expect(queue.get(job.id)?.execution?.events.some(event => event.title === "Codex session available")).toBe(true);
  }, 3000);

  it("escalates a failed verification and rechecks in the same thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-dynamic-route-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    const counter = join(root, "counter");
    mkdirSync(project); mkdirSync(bin);
    prepareTargetedProject(project);
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh
cat >/dev/null
count=$(cat '${counter}' 2>/dev/null || echo 0)
count=$((count + 1))
printf '%s' "$count" > '${counter}'
printf 'change\n' >> '${join(project, "src", "feature.ts")}'
for arg in "$@"; do
  case "$arg" in exec|resume|gpt-5.6-*|model_reasoning_effort=*|routing-thread) printf '%s ' "$arg" >> '${calls}' ;; esac
done
printf '\\n' >> '${calls}'
printf '%s\\n' '{"type":"thread.started","thread_id":"routing-thread"}'
if [ "$count" = 2 ]; then
  printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","command":"vitest run tests/feature.test.ts","exit_code":1}}'
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"JEV_VERIFICATION_FAILED"}}'
else
  printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","command":"vitest run tests/feature.test.ts","exit_code":0}}'
fi
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":5,"output_tokens":2,"reasoning_output_tokens":1}}'
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Fix a failing feature" }]);
    const analysis: JevAnalysis = { complexity: "medium", task_types: ["feature"], model: "luna", reasoning: "medium", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });
    const review = vi.fn(async () => true);
    const completed = await new Orchestrator(queue, async () => analysis, async () => undefined, accountUsage, undefined, undefined, undefined, review).run(job.id);

    const invocations = readFileSync(calls, "utf8").trim().split("\n");
    expect(invocations).toHaveLength(4);
    expect(review).toHaveBeenCalledWith("Fix a failing feature", ["src/feature.ts"], ["tests/feature.test.ts"]);
    expect(invocations[1]).toContain("exec resume");
    expect(invocations[1]).toContain("gpt-5.6-luna");
    expect(invocations[1]).toContain('model_reasoning_effort="low"');
    expect(invocations[2]).toContain("routing-thread");
    expect(invocations[2]).toContain("gpt-5.6-luna");
    expect(invocations[2]).toContain('model_reasoning_effort="high"');
    expect(completed.status).toBe("SUCCESS");
    expect(completed.execution?.threadId).toBe("routing-thread");
    expect(completed.execution?.usage).toMatchObject({ input_tokens: 40, output_tokens: 8 });
    expect(completed.execution?.metrics).toMatchObject({ actualTokens: 48, turns: 4, repairs: 1, stoppedAfterValidation: true });
    expect(completed.execution?.verification).toBe("tests_passed");
    expect(completed.execution?.events.filter(event => event.title === "Codex reasoning changed").map(event => event.detail)).toEqual([
      "verification: gpt-5.6-luna · low reasoning",
      "repair: gpt-5.6-luna · high reasoning",
      "verification: gpt-5.6-luna · low reasoning"
    ]);
    expect(completed.execution?.events.some(event => event.title === "JEV approved targeted tests" && event.detail === "tests/feature.test.ts")).toBe(true);
    expect(completed.execution?.metrics?.routes.map(route => route.usage?.input_tokens)).toEqual([10, 10, 10, 10]);
    expect(completed.execution?.metrics?.routes.map(route => route.usage?.cached_input_tokens)).toEqual([5, 5, 5, 5]);
  }, 3000);

  it("stops after an explicit successful verification instead of routing a repair", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-validation-stop-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    const counter = join(root, "counter");
    mkdirSync(project); mkdirSync(bin);
    prepareTargetedProject(project);
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh
cat >/dev/null
count=$(cat '${counter}' 2>/dev/null || echo 0)
count=$((count + 1))
printf '%s' "$count" > '${counter}'
printf 'change\n' >> '${join(project, "src", "feature.ts")}'
printf 'run\n' >> '${calls}'
printf '%s\n' '{"type":"thread.started","thread_id":"validation-thread"}'
if [ "$count" = 2 ]; then
  printf '%s\n' '{"type":"item.completed","item":{"type":"command_execution","command":"vitest run tests/feature.test.ts","exit_code":1}}'
  printf '%s\n' '{"type":"item.completed","item":{"type":"command_execution","command":"vitest run tests/feature.test.ts","exit_code":0}}'
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Checks passed. JEV_VERIFICATION_PASSED"}}'
fi
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Validate a focused change" }]);
    const analysis: JevAnalysis = { complexity: "low", task_types: ["feature"], model: "luna", reasoning: "medium", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });

    const completed = await new Orchestrator(queue, async () => analysis, async () => undefined, accountUsage, undefined, undefined, undefined, async () => true).run(job.id);

    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(completed.status).toBe("SUCCESS");
    expect(completed.execution?.metrics).toMatchObject({ estimatedTokens: expect.any(Number), actualTokens: 24, turns: 2, repairs: 0, stoppedAfterValidation: true });
    expect(completed.execution?.metrics?.routes.map(route => route.stage)).toEqual(["implementation", "verification"]);
    expect(completed.execution?.events.some(event => event.title === "Verification satisfied")).toBe(true);
  }, 3000);

  it("keeps a completed ticket successful when only verification dependencies are missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-env-verification-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    prepareTargetedProject(project);
    const commandEvent = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "vitest run tests/feature.test.ts", aggregated_output: "2 passed in 0.08s\nERROR Unmet dependencies (checked against /tmp/project/.venv/bin/python):\n\twheel\n\t\twanted: any\n\t\tfound: not installed\nSTATUS tests=1", exit_code: 0 } });
    writeFileSync(join(bin, "codex"), `#!/bin/sh
cat >/dev/null
printf 'run\n' >> '${calls}'
printf 'change\n' >> '${join(project, "src", "feature.ts")}'
printf '%s\n' '{"type":"thread.started","thread_id":"env-thread"}'
if [ "$(wc -l < '${calls}')" = 2 ]; then
  printf '%s\n' '${commandEvent}'
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Verification is environment-blocked. JEV_VERIFICATION_ENVIRONMENT_BLOCKED"}}'
fi
printf '%s\n' '{"type":"turn.completed"}'
`);
    chmodSync(join(bin, "codex"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Add GitHub profile lookup" }]);
    const analysis: JevAnalysis = { complexity: "medium", task_types: ["feature"], model: "terra", reasoning: "medium", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });

    const completed = await new Orchestrator(queue, async () => analysis, async () => undefined, accountUsage, undefined, undefined, undefined, async () => true).run(job.id);

    expect(completed.status).toBe("SUCCESS");
    expect(completed.execution?.verification).toBe("environment_blocked");
    expect(completed.execution?.metrics).toMatchObject({ turns: 2, repairs: 0 });
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(completed.execution?.events.some(event => event.title === "Verification partially blocked" && event.detail?.includes("wheel"))).toBe(true);
    expect(completed.execution?.verificationNote).toContain("wheel");
  }, 3000);

  it("honors JEV's decision to skip tests even when a related test exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-skip-verification-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    prepareTargetedProject(project);
    writeFileSync(join(bin, "codex"), `#!/bin/sh
cat >/dev/null
printf 'run\n' >> '${calls}'
printf 'change\n' >> '${join(project, "src", "feature.ts")}'
printf '%s\n' '{"type":"thread.started","thread_id":"skip-thread"}' '{"type":"turn.completed"}'
`);
    chmodSync(join(bin, "codex"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Adjust feature" }]);
    const analysis: JevAnalysis = { complexity: "low", task_types: ["feature"], model: "luna", reasoning: "low", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });
    const review = vi.fn(async () => false);

    const completed = await new Orchestrator(queue, async () => analysis, async () => undefined, accountUsage, undefined, undefined, undefined, review).run(job.id);

    expect(review).toHaveBeenCalledWith("Adjust feature", ["src/feature.ts"], ["tests/feature.test.ts"]);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
    expect(completed.status).toBe("SUCCESS");
    expect(completed.execution?.verificationNote).toContain("unnecessary");
  }, 3000);

  it("does not start a repair loop when approved tests were not run", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-unrun-verification-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    prepareTargetedProject(project);
    writeFileSync(join(bin, "codex"), `#!/bin/sh
cat >/dev/null
printf 'run\n' >> '${calls}'
printf 'change\n' >> '${join(project, "src", "feature.ts")}'
printf '%s\n' '{"type":"thread.started","thread_id":"unrun-thread"}' '{"type":"turn.completed"}'
`);
    chmodSync(join(bin, "codex"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Adjust feature" }]);
    const analysis: JevAnalysis = { complexity: "low", task_types: ["feature"], model: "luna", reasoning: "medium", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });

    const completed = await new Orchestrator(queue, async () => analysis, async () => undefined, accountUsage, undefined, undefined, undefined, async () => true).run(job.id);

    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(completed.status).toBe("SUCCESS");
    expect(completed.execution?.metrics?.repairs).toBe(0);
    expect(completed.execution?.verificationNote).toContain("did not run");
  }, 3000);

  it("does not accept a broad test command as targeted verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-broad-verification-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    prepareTargetedProject(project);
    writeFileSync(join(bin, "codex"), `#!/bin/sh
cat >/dev/null
printf 'run\n' >> '${calls}'
printf 'change\n' >> '${join(project, "src", "feature.ts")}'
printf '%s\n' '{"type":"thread.started","thread_id":"broad-thread"}'
if [ "$(wc -l < '${calls}')" = 2 ]; then
  printf '%s\n' '{"type":"item.completed","item":{"type":"command_execution","command":"npm test","exit_code":0}}'
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"JEV_VERIFICATION_PASSED"}}'
fi
printf '%s\n' '{"type":"turn.completed"}'
`);
    chmodSync(join(bin, "codex"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Adjust feature" }]);
    const analysis: JevAnalysis = { complexity: "low", task_types: ["feature"], model: "luna", reasoning: "medium", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });

    const completed = await new Orchestrator(queue, async () => analysis, async () => undefined, accountUsage, undefined, undefined, undefined, async () => true).run(job.id);

    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(completed.status).toBe("SUCCESS");
    expect(completed.execution?.verification).toBe("not_run");
    expect(completed.execution?.verificationNote).toContain("outside JEV's approved test scope");
  }, 3000);

  it("escalates a persistent code failure to Sol with high reasoning", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-sol-repair-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    prepareTargetedProject(project);
    writeFileSync(join(bin, "codex"), `#!/bin/sh
cat >/dev/null
printf 'change\n' >> '${join(project, "src", "feature.ts")}'
for arg in "$@"; do
  case "$arg" in gpt-5.6-*|model_reasoning_effort=*) printf '%s ' "$arg" >> '${calls}' ;; esac
done
printf '\n' >> '${calls}'
printf '%s\n' '{"type":"thread.started","thread_id":"sol-thread"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"command_execution","command":"vitest run tests/feature.test.ts","aggregated_output":"2 failed, 1 passed","exit_code":1}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"JEV_VERIFICATION_FAILED"}}'
printf '%s\n' '{"type":"turn.completed"}'
`);
    chmodSync(join(bin, "codex"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Fix failing test" }]);
    const analysis: JevAnalysis = { complexity: "medium", task_types: ["bugfix"], model: "luna", reasoning: "medium", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });

    const compactor = vi.fn(async () => undefined);
    const completed = await new Orchestrator(queue, async () => analysis, compactor, accountUsage, undefined, undefined, async () => ({ capturedAt: "2026-09-22T00:00:00.000Z", context: { usedTokens: 95_000, windowTokens: 258_000 } }), async () => true).run(job.id);

    expect(completed.status).toBe("FAILED");
    expect(compactor).toHaveBeenCalledWith("sol-thread");
    expect(completed.execution?.metrics).toMatchObject({ turns: 6, repairs: 2 });
    expect(completed.execution?.metrics?.routes.map(route => route.stage)).toEqual(["implementation", "verification", "repair", "verification", "repair", "verification"]);
    const invocations = readFileSync(calls, "utf8").trim().split("\n");
    expect(invocations[4]).toContain("gpt-5.6-sol");
    expect(invocations[4]).toContain('model_reasoning_effort="high"');
    expect(invocations[5]).toContain("gpt-5.6-sol");
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
  case "$arg" in exec|resume|gpt-5.6-*|model_reasoning_effort=*|requested-thread) printf '%s ' "$arg" >> '${calls}' ;; esac
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
    const analysis: JevAnalysis = { complexity: "medium", task_types: ["feature"], model: "terra", reasoning: "medium", context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev" };
    queue.update(job.id, { analysis });
    const completed = await new Orchestrator(queue, async () => analysis, async () => undefined, accountUsage).run(job.id);
    const invocations = readFileSync(calls, "utf8").trim().split("\n");

    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toContain("gpt-5.6-terra");
    expect(invocations[1]).toContain("gpt-5.6-terra");
    expect(invocations[1]).toContain('model_reasoning_effort="high"');
    expect(completed.status).toBe("SUCCESS");
    expect(completed.execution?.usage?.input_tokens).toBe(6);
  }, 3000);

  it("groups compatible consecutive tasks into one Codex prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-batch-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "package.json"), "{}");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\ncat >/dev/null\nprintf 'run\\n' >> '${calls}'\nprintf '%s\\n' '{"type":"thread.started","thread_id":"batch-thread"}' '{"type":"turn.completed"}'\n`);
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
      (projectPath, tasks) => analyze(projectPath, tasks, async () => ({ taskType: decisions[decision++], complexity: "low" })),
      async () => undefined,
      accountUsage
    );
    await orchestrator.runBatch(jobs[0].id);

    expect(queue.listBatch(jobs[0].batchId!).map(job => job.status)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
    expect(queue.listBatch(jobs[0].batchId!)[0].analysis?.model).toBe("luna");
    expect(queue.listBatch(jobs[0].batchId!)[1].analysis?.model).toBe("luna");
    expect(queue.listBatch(jobs[0].batchId!)[0].execution?.group?.size).toBe(3);
    expect(queue.listBatch(jobs[0].batchId!)[2].execution?.events.some(event => event.title === "Codex /compact started")).toBe(true);
    expect(queue.listBatch(jobs[0].batchId!)[2].execution?.events.some(event => event.title === "Codex /compact confirmed")).toBe(true);
  }, 3000);

  it("keeps a failed compatible group visible without stopping the batch", async () => {
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
    await new Orchestrator(queue, analyzerFor("feature"), async () => undefined, accountUsage).runBatch(jobs[0].id);

    expect(queue.listBatch(jobs[0].batchId!).map(job => job.status)).toEqual(["FAILED", "FAILED"]);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
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
    writeFileSync(fakeCodex, `#!/bin/sh\ncat >/dev/null\ncount=$(cat '${counter}' 2>/dev/null || echo 0)\ncount=$((count + 1))\nprintf '%s' "$count" > '${counter}'\nprintf 'run\\n' >> '${calls}'\nif [ "$count" = 1 ]; then\n  printf '%s\\n' '2026-01-01 ERROR patch rejected: writing is blocked by read-only sandbox' >&2\nelse\n  printf '%s\\n' '{"type":"thread.started","thread_id":"retry-thread"}' '{"type":"turn.completed"}'\nfi\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    const queue = new JobQueue(join(root, "queue"));
    const jobs = queue.createBatch("project-1", project, [
      { description: "First change" },
      { description: "Independent follow-up" }
    ]);
    const decisions = [
      { model: "luna", reasoning: "low" },
      { model: "terra", reasoning: "medium" }
    ] as const;
    let index = 0;
    await new Orchestrator(queue, async () => ({
      complexity: "low", task_types: ["feature"],       ...decisions[index++], context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev"
    }), async () => undefined, accountUsage).runBatch(jobs[0].id);

    const result = queue.listBatch(jobs[0].batchId!);
    expect(result.map(job => job.status)).toEqual(["SUCCESS", "SUCCESS"]);
    expect(result[0].attempts).toBe(2);
    expect(result[1].attempts).toBe(1);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(3);
  }, 3000);

  it("groups Luna Low with Luna Medium, but not a later Luna High task", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-group-boundary-"));
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
      { model: "luna", reasoning: "low" },
      { model: "luna", reasoning: "medium" },
      { model: "luna", reasoning: "high" }
    ] as const;
    let index = 0;
    await new Orchestrator(queue, async () => ({
      complexity: "low", task_types: ["feature"],       ...decisions[index++], context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev"
    }), async () => undefined, accountUsage).runBatch(jobs[0].id);

    const result = queue.listBatch(jobs[0].batchId!);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(result.map(job => job.status)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
    expect(result[0].execution?.group?.size).toBe(2);
    expect(result[1].execution?.group?.position).toBe(2);
    expect(result[2].execution?.group).toBeUndefined();
    expect(result[0].execution?.reasoning).toBe("medium");
    expect(result[2].execution?.reasoning).toBe("high");
    expect(result[2].execution?.events.some(event => event.title === "JEV selection applied" && event.detail?.includes("high"))).toBe(true);
  }, 3000);

  it("groups Luna Medium with a following Luna Low task in the same prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-descending-group-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "package.json"), "{}");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\ncat >/dev/null\nprintf 'run\\n' >> '${calls}'\nprintf '%s\\n' '{"type":"thread.started","thread_id":"descending-thread"}' '{"type":"turn.completed"}'\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const jobs = queue.createBatch("project-1", project, [{ description: "First routine change" }, { description: "Second trivial change" }]);
    const decisions = [
      { model: "luna", reasoning: "medium" },
      { model: "luna", reasoning: "low" }
    ] as const;
    let index = 0;
    await new Orchestrator(queue, async () => ({
      complexity: "low", task_types: ["feature"],       ...decisions[index++], context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev"
    }), async () => undefined, accountUsage).runBatch(jobs[0].id);

    const result = queue.listBatch(jobs[0].batchId!);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
    expect(result.map(job => job.execution?.group?.size)).toEqual([2, 2]);
    expect(result.map(job => job.execution?.reasoning)).toEqual(["medium", "medium"]);
  }, 3000);

  it("groups the next compatible project ticket even when it was submitted in a later batch", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-cross-batch-group-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const calls = join(root, "calls.log");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "package.json"), "{}");
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\ncat >/dev/null\nprintf 'run\\n' >> '${calls}'\nprintf '%s\\n' '{"type":"thread.started","thread_id":"cross-batch-thread"}' '{"type":"turn.completed"}'\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    const queue = new JobQueue(join(root, "queue"));
    const firstBatch = queue.createBatch("project-1", project, [{ description: "Fix the upper obstacle" }]);
    const secondBatch = queue.createBatch("project-1", project, [{ description: "Apply the cyberpunk theme" }]);
    const decisions = [
      { model: "luna", reasoning: "medium" },
      { model: "luna", reasoning: "medium" }
    ] as const;
    let index = 0;
    await new Orchestrator(queue, async () => ({
      complexity: "low", task_types: ["feature"],       ...decisions[index++], context_files: [], files_to_modify: [], rationale: [], evaluator: "typesafe-ai/jev"
    }), async () => undefined, accountUsage).runBatch(firstBatch[0].id);

    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
    expect(queue.get(firstBatch[0].id)?.execution?.group?.size).toBe(2);
    expect(queue.get(secondBatch[0].id)?.execution?.group?.position).toBe(2);
    expect(queue.get(secondBatch[0].id)?.status).toBe("SUCCESS");
  }, 3000);

  it("compacts and clears an idle project thread without deleting task history", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-thread-controls-"));
    const project = join(root, "project");
    mkdirSync(project);
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project-1", project, [{ description: "Completed work" }]);
    queue.transition(job.id, "SUCCESS", { execution: { phase: "COMPLETED", model: "gpt-5.6-luna", reasoning: "low", startedAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-01-01T00:00:00.000Z", threadId: "thread-to-control", verification: "not_run", events: [] } });
    queue.recordProjectThread("project-1", "thread-to-control");
    queue.recordSuccessfulTasks("project-1", 1);
    const compacted: string[] = [];
    const archived: string[] = [];
    const orchestrator = new Orchestrator(queue, analyzerFor("feature"), async threadId => { compacted.push(threadId); }, accountUsage, async threadId => { archived.push(threadId); });

    await expect(orchestrator.compactProjectThread("project-1")).resolves.toMatchObject({ threadId: "thread-to-control", successfulSinceCompaction: 0 });
    expect(compacted).toEqual(["thread-to-control"]);
    await expect(orchestrator.clearProjectThread("project-1")).resolves.toMatchObject({ threadId: "thread-to-control", successfulSinceCompaction: 0 });
    expect(archived).toEqual(["thread-to-control"]);
    expect(queue.get(job.id)?.status).toBe("SUCCESS");
    expect(queue.get(job.id)?.execution?.threadArchivedAt).toBeTruthy();
    expect(orchestrator.projectThreadStatus("project-1").threadId).toBeUndefined();
  });
});
