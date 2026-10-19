import { createExecutionProvider } from "../../src/core/execution/provider.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Orchestrator } from "../../src/core/orchestrator.js";
import { JobQueue } from "../../src/core/queue.js";
import type { JevAnalysis } from "../../src/core/types.js";

vi.mock("../../src/core/project-linter.js", async importOriginal => ({ ...await importOriginal<typeof import("../../src/core/project-linter.js")>(), ensureProjectLinterTicket: () => undefined }));
vi.mock("../../src/core/execution/codex/catalog.js", async importOriginal => ({ ...await importOriginal<typeof import("../../src/core/execution/codex/catalog.js")>(), activeCodexModelId: async () => "test-model" }));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), "jev-continuation-"));
  roots.push(root);
  const project = join(root, "project");
  const bin = join(root, "bin");
  mkdirSync(project); mkdirSync(bin);
  const executable = join(bin, "codex");
  writeFileSync(executable, `#!/bin/sh\n${script}`);
  chmodSync(executable, 0o755);
  vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
  vi.stubEnv("CODEX_HOME", join(root, "codex-home"));
  const data = join(root, "data");
  const queue = new JobQueue(data);
  const [job, next] = queue.createBatch("project", project, [{ description: "Implement feature" }, { description: "Read the result" }]);
  const analysis: JevAnalysis = { complexity: 3, model: "sol", reasoning: "high", task_types: ["feature"], rationale: [], evaluator: "typesafe-ai/jev" };
  queue.update(job.id, { analysis });
  queue.update(next.id, { analysis: { ...analysis, task_types: ["research"] } });
  const status = async () => ({ capturedAt: new Date().toISOString() });
  const createOrchestrator = (targetQueue = queue) => new Orchestrator(targetQueue, { analyzer: async () => analysis, provider: { ...createExecutionProvider(), compactThread: async () => undefined, readAccountUsage: status, archiveThread: async () => undefined, readStatus: status }, continuityReviewer: async () => "related" });
  return { root, project, executable, data, queue, job, next, orchestrator: createOrchestrator(), createOrchestrator };
}

describe("uninterrupted Codex work", () => {
  it.each([
    ["no file changes", "printf '%s\\n' '{\"type\":\"turn.completed\"}'"],
    ["process failure", "exit 2"],
    ["failed turn with exit zero", "printf '%s\\n' '{\"type\":\"turn.failed\",\"error\":{\"message\":\"Temporary service failure\"}}'"],
    ["terminated process", "kill -TERM $$"]
  ])("continues after %s in the same thread without entering Failed", async (_name, failure) => {
    const { root, project, data, queue, job, next, orchestrator } = fixture(`
printf '%s\\n' "$@" >> ../arguments
printf '%s\\n' '{"type":"thread.started","thread_id":"work-thread"}'
if [ ! -e ../first-attempt ]; then
  printf first > ../first-attempt
  printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
  ${failure}
else
  printf 'solution' > result.txt
  printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":20,"output_tokens":10}}'
fi
`);
    // Human review must wait for the ticket to finish, not its first process exit.
    orchestrator.configureHumanReview(() => true);
    const transitions = vi.spyOn(queue, "transition");
    const running = orchestrator.runBatch(job.id);
    await vi.waitFor(() => expect(queue.get(job.id)).toMatchObject({ status: "RUNNING", execution: { continuationPending: true, phase: "QUEUED" } }));
    expect(queue.get(job.id)?.awaitingHumanReview).toBeFalsy();
    expect(queue.get(next.id)?.status).toBe("PENDING");
    expect(orchestrator.isProjectRunning("project")).toBe(true);
    expect(new JobQueue(data).get(job.id)).toMatchObject({ status: "RUNNING", analysis: { model: "sol", reasoning: "high" }, execution: { threadId: "work-thread", continuationPending: true } });
    await expect(orchestrator.run(next.id)).rejects.toThrow("already running");
    await running;
    expect(queue.get(job.id)).toMatchObject({ status: "SUCCESS", attempts: 2, awaitingHumanReview: true, execution: { continuationPending: false } });
    expect(queue.get(job.id)?.output).toContain("continuation attempt");
    expect(queue.get(job.id)?.execution?.usage).toMatchObject({ input_tokens: 30, output_tokens: 15 });
    expect(transitions.mock.calls.some(([, status]) => status === "FAILED")).toBe(false);
    expect(readFileSync(join(root, "arguments"), "utf8")).toContain("resume\n");
    expect(readFileSync(join(root, "arguments"), "utf8")).toContain("work-thread\n");
    expect(readFileSync(join(project, "result.txt"), "utf8")).toBe("solution");
    expect(orchestrator.isProjectRunning("project")).toBe(false);
  });

  it("retries an unavailable executable and starts once it becomes available", async () => {
    const { executable, queue, job, orchestrator } = fixture("");
    // A missing interpreter produces a real spawn error without invoking Codex.
    writeFileSync(executable, "#!/missing-jev-test-interpreter\n");
    vi.stubEnv("PATH", join(executable, ".."));
    const transitions = vi.spyOn(queue, "transition");
    const running = orchestrator.run(job.id);
    await vi.waitFor(() => expect(queue.get(job.id)?.recoveryNote).toContain("Could not start Codex"));
    expect(queue.get(job.id)?.status).toBe("RUNNING");
    writeFileSync(executable, `#!/bin/sh
printf solution > result.txt
printf '%s\\n' '{"type":"turn.completed"}'
`);
    expect((await running).status).toBe("SUCCESS");
    expect(transitions.mock.calls.some(([, status]) => status === "FAILED")).toBe(false);
  });

  it("keeps a silent process alive beyond the former inactivity limit", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const { root, queue, job, orchestrator } = fixture(`
printf '%s\\n' '{"type":"thread.started","thread_id":"quiet-thread"}'
while [ ! -e ../release ]; do sleep 0.05; done
printf solution > result.txt
printf '%s\\n' '{"type":"turn.completed"}'
`);
    const running = orchestrator.run(job.id);
    try {
      await vi.waitFor(() => expect(queue.get(job.id)?.execution?.threadId).toBe("quiet-thread"));
      const current = queue.get(job.id)!;
      queue.update(job.id, { execution: { ...current.execution!, lastActivityAt: new Date(Date.now() - 31 * 60_000).toISOString() } });
      const heartbeat = intervals.mock.calls.find(([, delay]) => delay === 10_000)![0];
      (heartbeat as () => void)();
      expect(queue.get(job.id)?.status).toBe("RUNNING");
    } finally { writeFileSync(join(root, "release"), "continue"); }
    const completed = await running;
    expect(completed).toMatchObject({ status: "SUCCESS", attempts: 1 });
  });

  it("resumes persisted unfinished work at its selected route after a server restart", async () => {
    const { data, queue, job, createOrchestrator } = fixture(`
printf '%s\\n' "$@" > ../arguments
printf solution > result.txt
printf '%s\\n' '{"type":"turn.completed"}'
`);
    const at = new Date().toISOString();
    queue.transition(job.id, "RUNNING", { execution: { phase: "QUEUED", model: "test-model", reasoning: "high", startedAt: at, lastActivityAt: at, threadId: "saved-thread", continuationPending: true, events: [] } });
    queue.recoverInterrupted(() => false);
    const restored = new JobQueue(data);
    expect(restored.get(job.id)).toMatchObject({ status: "PENDING", analysis: { model: "sol", reasoning: "high" }, execution: { continuationPending: true } });
    expect((await createOrchestrator(restored).run(job.id)).status).toBe("SUCCESS");
    expect(readFileSync(join(data, "..", "arguments"), "utf8")).toContain("saved-thread\n");
  });
});
