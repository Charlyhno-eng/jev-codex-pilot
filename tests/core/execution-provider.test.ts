import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Orchestrator } from "../../src/core/orchestrator.js";
import { JobQueue } from "../../src/core/queue.js";
import { createExecutionProvider, findExecutionProvider } from "../../src/core/execution/provider.js";
import { formatExecutionConsole } from "../../src/core/execution/console.js";
import type { ExecutionProvider, ExecutionResult } from "../../src/core/execution/types.js";
import type { JevAnalysis } from "../../src/core/types.js";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(() => { throw new Error("No coding CLI may be launched by this test"); }) }));
vi.mock("../../src/core/project-linter.js", async importOriginal => ({ ...await importOriginal<typeof import("../../src/core/project-linter.js")>(), ensureProjectLinterTicket: () => undefined }));

const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const analysis: JevAnalysis = { complexity: 3, model: "sol", reasoning: "low", task_types: ["feature"], rationale: [], evaluator: "typesafe-ai/jev" };
const success: ExecutionResult = { success: true, implementationBlocked: false, quotaReached: false };
function fixture(capabilities = { resume: true, images: false, compaction: false, archive: false }) {
  const root = mkdtempSync(join(tmpdir(), "jev-other-ai-"));
  roots.push(root);
  const project = join(root, "project"); mkdirSync(project);
  const data = join(root, "data");
  const queue = new JobQueue(data);
  const job = queue.create("project", project, [{ description: "Implement a feature" }]);
  queue.update(job.id, { analysis });
  const provider: ExecutionProvider = {
    id: "other-ai", label: "Other AI", capabilities,
    createContext: vi.fn((_id, projectPath) => ({ projectPath })),
    modelId: () => "other-model", resolveModel: vi.fn(async () => "other-model"),
    models: vi.fn(async () => ({ sol: "other-model" })),
    command: vi.fn(async () => "other-ai <task>"),
    run: vi.fn(async (request, observer) => {
      observer.onStart({ command: "other-ai <task>" });
      observer.onOutput("Plain text from another AI, without Codex JSONL.");
      observer.onUpdate({ phase: "WORKING", threadId: "shared-id", event: { kind: "message", title: "Other AI update", detail: "Implemented the feature", status: "success" } });
      observer.onUpdate({ phase: "FINISHING", usage: { input_tokens: 12, output_tokens: 3 }, verification: "tests_passed" });
      writeFileSync(join(request.context.projectPath, "result.txt"), "Implemented by another provider");
      return success;
    }),
    compactThread: vi.fn(async () => { throw new Error("Unsupported compaction must not be called"); }),
    archiveThread: vi.fn(async () => { throw new Error("Unsupported archival must not be called"); }),
    readAccountUsage: vi.fn(async () => ({ capturedAt: new Date().toISOString(), unavailableReason: "Not offered by this provider" })),
    readRateLimit: vi.fn(async () => ({ available: true, reached: false })),
    readStatus: vi.fn(async () => ({ capturedAt: new Date().toISOString(), context: { usedTokens: 120_000, windowTokens: 200_000 } })),
    implementationBlocked: vi.fn(() => false), ownsProcess: () => false
  };
  const orchestrator = new Orchestrator(queue, { provider, continuityReviewer: async () => "related" });
  return { root, project, data, queue, job, provider, orchestrator };
}

describe("coding AI provider boundary", () => {
  it("executes, records usage, and previews a different provider without launching Codex", async () => {
    const { project, queue, job, provider, orchestrator } = fixture();
    expect(spawn).not.toHaveBeenCalled();
    expect(await orchestrator.command(queue.get(job.id)!)).toBe("other-ai <task>");
    expect(provider.run).not.toHaveBeenCalled();
    const completed = await orchestrator.run(job.id);
    expect(completed).toMatchObject({ status: "SUCCESS", execution: { providerId: "other-ai", providerName: "Other AI", model: "other-model", threadId: "shared-id", verification: "tests_passed", usage: { input_tokens: 12, output_tokens: 3 }, metrics: { actualTokens: 15 } } });
    expect(completed.output).toContain("Plain text from another AI");
    expect(readFileSync(join(project, "result.txt"), "utf8")).toContain("another provider");
    expect(provider.readStatus).toHaveBeenCalledWith("shared-id", { projectPath: project });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("continues technical errors through the injected provider and keeps queue ownership", async () => {
    const { queue, job, provider, orchestrator } = fixture();
    vi.mocked(provider.run).mockImplementationOnce(async (_request, observer) => {
      observer.onUpdate({ phase: "WORKING", threadId: "partial-thread" });
      throw new Error("Temporary connection failure");
    });
    const transitions = vi.spyOn(queue, "transition");
    const running = orchestrator.run(job.id);
    await vi.waitFor(() => expect(queue.get(job.id)).toMatchObject({ status: "RUNNING", execution: { continuationPending: true } }));
    expect(orchestrator.ownsProjectRun("project")).toBe(true);
    expect((await running).status).toBe("SUCCESS");
    expect(vi.mocked(provider.run).mock.calls[1][0]).toMatchObject({ threadId: "partial-thread", model: "other-model" });
    expect(transitions.mock.calls.some(([, status]) => status === "FAILED")).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("never resumes or archives another provider's thread, even when IDs match", async () => {
    const { queue, job, provider } = fixture();
    const previous = queue.create("project", job.projectPath, [{ description: "Old Codex work" }]);
    const at = new Date().toISOString();
    queue.transition(previous.id, "SUCCESS", { execution: { phase: "COMPLETED", model: "old-codex", reasoning: "low", startedAt: at, lastActivityAt: at, threadId: "shared-id", verification: "not_run", events: [] } });
    const next = queue.create("project", job.projectPath, [{ description: "Next task" }]);
    queue.update(next.id, { analysis: { ...analysis, task_types: ["research"] } });
    const orchestrator = new Orchestrator(queue, { provider, continuityReviewer: async () => "unrelated" });
    await orchestrator.run(job.id);
    expect(vi.mocked(provider.run).mock.calls[0][0].threadId).toBeUndefined();
    expect(vi.mocked(provider.createContext).mock.calls[0][2]).not.toContain("shared-id");
    expect(queue.get(previous.id)?.execution?.threadArchivedAt).toBeUndefined();
    expect(queue.get(job.id)?.execution?.threadArchivedAt).toBeDefined();
    expect(provider.archiveThread).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("honors missing session and compaction capabilities", async () => {
    const { queue, job, provider, orchestrator } = fixture({ resume: false, images: false, compaction: false, archive: false });
    const next = queue.create("project", job.projectPath, [{ description: "Read result" }]);
    queue.update(next.id, { analysis: { ...analysis, task_types: ["research"] } });
    await orchestrator.runBatch(job.id);
    expect(vi.mocked(provider.run).mock.calls.map(([request]) => request.threadId)).toEqual([undefined, undefined]);
    expect(provider.compactThread).not.toHaveBeenCalled();
    expect(provider.archiveThread).not.toHaveBeenCalled();
    expect(queue.get(next.id)?.status).toBe("SUCCESS");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("pauses and resumes a different provider's quota using the common contract", async () => {
    const { queue, job, provider, orchestrator } = fixture();
    const reset = "2099-01-01T00:00:00.000Z";
    vi.mocked(provider.run).mockResolvedValueOnce({ success: false, implementationBlocked: false, quotaReached: true, retryAt: reset });
    const paused = await orchestrator.run(job.id);
    expect(paused).toMatchObject({ status: "SESSION_PAUSED", execution: { providerId: "other-ai" } });
    expect(paused.execution?.events.some(event => event.title === "Other AI session limit reached")).toBe(true);
    expect(paused.sessionResumeAt).toBe("2099-01-01T00:01:00.000Z");
    expect(await orchestrator.resumeSessionPausedJobs()).toEqual([]);
    queue.update(job.id, { sessionResumeAt: new Date(Date.now() - 1_000).toISOString() });
    expect((await orchestrator.resumeSessionPausedJobs()).map(item => item.id)).toEqual([job.id]);
    expect((await orchestrator.run(job.id)).status).toBe("SUCCESS");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not automatically resume quota-paused tickets from another provider", async () => {
    const { queue, job, provider, orchestrator } = fixture();
    const at = new Date().toISOString();
    queue.transition(job.id, "SESSION_PAUSED", {
      sessionResumeAt: new Date(Date.now() - 1_000).toISOString(),
      execution: { phase: "ERROR", model: "old-codex", reasoning: "low", startedAt: at, lastActivityAt: at, verification: "not_run", events: [] }
    });
    expect(await orchestrator.resumeSessionPausedJobs()).toEqual([]);
    queue.update(job.id, { sessionResumeAt: undefined });
    expect(await orchestrator.resumeSessionPausedJobs()).toEqual([]);
    expect(queue.get(job.id)?.status).toBe("SESSION_PAUSED");
    expect(provider.readRateLimit).not.toHaveBeenCalled();
    expect(provider.run).not.toHaveBeenCalled();
  });

  it("selects adapters without starting them and rejects unknown providers", () => {
    expect(createExecutionProvider().id).toBe("codex");
    expect(findExecutionProvider("not-installed")).toBeUndefined();
    vi.stubEnv("JEV_EXECUTION_PROVIDER", "not-installed");
    expect(() => createExecutionProvider()).toThrow("Unknown execution provider");
    expect(() => createExecutionProvider("toString")).toThrow("Unknown execution provider");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("formats alternate output without interpreting it as Codex protocol", () => {
    const output = 'Plain text\n{"type":"turn.failed","message":"a quoted example"}';
    expect(formatExecutionConsole(output, "other-ai")).toBe(output);
    expect(formatExecutionConsole('{"type":"turn.started"}', "codex")).toContain("planning");
  });
});
