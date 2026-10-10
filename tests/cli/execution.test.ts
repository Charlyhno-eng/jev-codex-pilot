import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, ProjectRecord } from "../../src/core/types.js";

const mocks = vi.hoisted(() => ({
  config: { jevProvider: "vercel-ai-gateway", aiGatewayApiKey: "test-key" },
  status: "SUCCESS" as Job["status"],
  release: vi.fn(),
  acquire: vi.fn(),
  createBatch: vi.fn(),
  runBatch: vi.fn(), humanReview: vi.fn()
}));

vi.mock("../../src/core/app-config.js", () => ({ AppConfigStore: class { read() { return mocks.config; } } }));
vi.mock("../../src/core/projects.js", () => ({ ProjectStore: class {
  create(path: string) { return { id: "project-1", name: "Example", path, createdAt: "", updatedAt: "" } as ProjectRecord; }
  get() { return { humanInTheLoop: true }; }
  list() { return []; }
  touch() {}
} }));
vi.mock("../../src/core/queue.js", () => ({ JobQueue: class {
  recoverInterrupted() {}
  list() { return []; }
  create(projectId: string, projectPath: string) { return { id: "ticket-1", projectId, projectPath, tasks: [{ description: "A task" }], status: "PENDING", createdAt: "", updatedAt: "", attempts: 0 } as Job; }
  createBatch(projectId: string, projectPath: string, tasks: Array<{ description: string }>) {
    mocks.createBatch(projectId, projectPath, tasks);
    return tasks.map((task, index) => ({ id: `ticket-${index + 1}`, projectId, projectPath, tasks: [task], status: "PENDING", createdAt: "", updatedAt: "", attempts: 0 }) as Job);
  }
  get(id: string) { return { id, projectId: "project-1", projectPath: "", tasks: [{ description: "A task" }], status: mocks.status, createdAt: "", updatedAt: "", attempts: 1 } as Job; }
} }));
vi.mock("../../src/core/orchestrator.js", () => ({ Orchestrator: class {
  configureGitDelivery() {}
  configureHumanReview(enabled: (id: string) => boolean) { mocks.humanReview(enabled("project-1")); }
  async prepare() { return undefined; }
  async run() { return { id: "ticket-1", projectId: "project-1", projectPath: "", tasks: [{ description: "A task" }], status: mocks.status, createdAt: "", updatedAt: "", attempts: 1 } as Job; }
  async runBatch(id: string) { mocks.runBatch(id); }
} }));
vi.mock("../../src/core/single-instance.js", () => ({ acquireApiInstance: () => mocks.acquire() }));

import { executeBatch, main } from "../../src/cli/main.js";

const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = "SUCCESS";
  mocks.acquire.mockResolvedValue(mocks.release);
  process.exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); process.exitCode = originalExitCode; });

function projectDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "jev-cli-run-"));
  writeFileSync(join(directory, "AGENTS.md"), "Project instructions.\n");
  return directory;
}

describe("CLI ticket execution", () => {
  it("returns instead of polling forever when an API batch pauses for human review", async () => {
    mocks.acquire.mockRejectedValueOnce(new Error("Another JEV API process is using the history"));
    const directory = projectDirectory();
    const pending = ["First", "Second"].map((description, index): Job => ({ id: `ticket-${index}`, projectId: "project", projectPath: directory, tasks: [{ description }], status: "PENDING", createdAt: "", updatedAt: "", attempts: 0 }));
    const responses = [
      { ok: true, app: "jev-codex-pilot" }, { configured: true },
      { id: "project", path: directory }, [], pending,
      pending[0], pending[1], pending[0],
      [{ ...pending[0], status: "SUCCESS", awaitingHumanReview: true }, pending[1]]
    ];
    const fetcher = vi.fn();
    for (const data of responses) fetcher.mockResolvedValueOnce({ ok: true, json: async () => data });
    vi.stubGlobal("fetch", fetcher);
    await executeBatch(directory, ["First", "Second"]);
    expect(fetcher).toHaveBeenCalledTimes(responses.length);
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("Waiting for human review"));
    expect(process.exitCode).toBe(1);
  });
  it("creates a terminal batch in submitted order and launches it once", async () => {
    await executeBatch(projectDirectory(), ["First", "Second"]);
    expect(mocks.createBatch).toHaveBeenCalledExactlyOnceWith("project-1", expect.any(String), [{ description: "First" }, { description: "Second" }]);
    expect(mocks.runBatch).toHaveBeenCalledExactlyOnceWith("ticket-1");
    expect(mocks.humanReview).toHaveBeenCalledWith(true);
  });
  it.each(["SUCCESS", "FAILED", "SESSION_PAUSED"] as const)("reports the %s result and releases the execution lock", async status => {
    mocks.status = status;
    await main(["run", "A task"], projectDirectory());
    expect(process.exitCode).toBe(status === "SUCCESS" ? 0 : 1);
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining(status));
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("releases the execution lock when the batch fails to start", async () => {
    mocks.runBatch.mockImplementationOnce(() => { throw new Error("Execution unavailable"); });
    await expect(executeBatch(projectDirectory(), ["First", "Second"])).rejects.toThrow("Execution unavailable");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
