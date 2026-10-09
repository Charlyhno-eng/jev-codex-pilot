import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureProjectLinterTicket, missingProjectLinters } from "../../src/core/project-linter.js";
import { JobQueue } from "../../src/core/queue.js";
import { Orchestrator } from "../../src/core/orchestrator.js";
import type { Job } from "../../src/core/types.js";

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "jev-linter-setup-")); roots.push(root);
  const project = join(root, "project"); mkdirSync(project);
  return { root, project, queue: new JobQueue(join(root, "queue")) };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("default project lint setup", () => {
  it("creates a durable setup ticket before existing work without changing project files", () => {
    const { root, project, queue } = setup();
    writeFileSync(join(project, "app.ts"), "export const answer = 42;\n");
    const work = queue.create("project", project, [{ description: "Implement a feature" }]);
    const ticket = ensureProjectLinterTicket(queue, "project", project)!;
    expect(ticket.kind).toBe("linter_setup");
    expect(ticket.status).toBe("PENDING");
    expect(queue.listProjectExecutionOrder("project").map(job => job.id)).toEqual([ticket.id, work.id]);
    expect(readFileSync(join(project, "app.ts"), "utf8")).toBe("export const answer = 42;\n");
    const restored = new JobQueue(join(root, "queue"));
    expect(ensureProjectLinterTicket(restored, "project", project)?.id).toBe(ticket.id);
    expect(restored.list()).toHaveLength(2);
  });
  it("keeps a failed setup visible without making duplicate tickets", () => {
    const { project, queue } = setup(); writeFileSync(join(project, "app.py"), "answer = 42\n");
    const ticket = ensureProjectLinterTicket(queue, "project", project)!;
    queue.transition(ticket.id, "FAILED");
    expect(ensureProjectLinterTicket(queue, "project", project)?.status).toBe("FAILED");
    expect(queue.list()).toHaveLength(1);
  });
  it("recognizes inherited ESLint setup, Ruff, and existing alternative linters", () => {
    const { project, queue } = setup(); mkdirSync(join(project, "src"));
    writeFileSync(join(project, "src", "app.ts"), "");
    writeFileSync(join(project, "package.json"), JSON.stringify({ devDependencies: { eslint: "*" } }));
    expect(missingProjectLinters(project)).toContain("JavaScript/TypeScript (.)");
    writeFileSync(join(project, "eslint.config.mjs"), "export default [];\n");
    expect(ensureProjectLinterTicket(queue, "project", project)).toBeUndefined();
    writeFileSync(join(project, "app.py"), "");
    writeFileSync(join(project, "pyproject.toml"), '[dependency-groups]\ndev = ["ruff>=0.5"]\n');
    expect(missingProjectLinters(project)).toEqual([]);
    writeFileSync(join(project, "package.json"), JSON.stringify({ devDependencies: { "@biomejs/biome": "*" } }));
    writeFileSync(join(project, "biome.json"), "{}");
    expect(missingProjectLinters(project)).toEqual([]);
  });
  it("detects every supported group, including manifest-only projects and nested packages", () => {
    const { project } = setup(); mkdirSync(join(project, "python"));
    for (const name of ["package.json", "Cargo.toml", "go.mod"]) writeFileSync(join(project, name), "{}");
    writeFileSync(join(project, "python", "pyproject.toml"), "");
    expect(missingProjectLinters(project)).toEqual(["Go toolchain lint setup", "JavaScript/TypeScript (.)", "Python (python)", "Rust toolchain lint setup"]);
    expect(missingProjectLinters(project, ["Go", "Rust"])).toEqual(["JavaScript/TypeScript (.)", "Python (python)"]);
  });
  it("detects removed config and newly added languages after a successful setup", () => {
    const { project, queue } = setup(); writeFileSync(join(project, "Cargo.toml"), "");
    const ticket = ensureProjectLinterTicket(queue, "project", project)!;
    queue.transition(ticket.id, "SUCCESS");
    expect(ensureProjectLinterTicket(queue, "project", project)).toBeUndefined();
    writeFileSync(join(project, "app.ts"), "");
    expect(ensureProjectLinterTicket(queue, "project", project)?.id).not.toBe(ticket.id);
  });
  it("ignores generated, private, and external symlink paths and leaves empty projects alone", () => {
    const { root, project, queue } = setup();
    expect(ensureProjectLinterTicket(queue, "project", project)).toBeUndefined();
    mkdirSync(join(project, "node_modules")); writeFileSync(join(project, "node_modules", "app.py"), "");
    mkdirSync(join(project, ".aws")); writeFileSync(join(project, ".aws", "app.py"), "");
    const outside = join(root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "app.py"), "");
    symlinkSync(outside, join(project, "linked"));
    expect(missingProjectLinters(project)).toEqual([]);
  });
  it.each([false, true])("runs setup before implementation on an explicit %s batch launch", async batch => {
    const { project, queue } = setup(); writeFileSync(join(project, "app.ts"), "");
    const work = queue.create("project", project, [{ description: "Implement a feature" }]);
    const orchestrator = new Orchestrator(queue);
    const run = vi.spyOn(orchestrator as unknown as { runWithEscalation(job: Job): Promise<Job> }, "runWithEscalation").mockImplementation(async job => {
      if (job.kind === "linter_setup") {
        writeFileSync(join(project, "package.json"), JSON.stringify({ devDependencies: { eslint: "*" } }));
        writeFileSync(join(project, "eslint.config.mjs"), "export default [];\n");
      }
      return queue.transition(job.id, "SUCCESS")!;
    });
    if (batch) await orchestrator.runBatch(work.id); else await orchestrator.run(work.id);
    expect(run.mock.calls.map(([job]) => job.kind ?? "implementation")).toEqual(["linter_setup", "implementation"]);
    expect(queue.get(work.id)?.status).toBe("SUCCESS");
    expect(orchestrator.isProjectRunning("project")).toBe(false);
  });
  it.each(["FAILED", "SESSION_PAUSED"] as const)("leaves implementation pending after setup %s and releases the project lock", async status => {
    const { project, queue } = setup(); writeFileSync(join(project, "app.py"), "");
    const work = queue.create("project", project, [{ description: "Implement a feature" }]);
    const orchestrator = new Orchestrator(queue);
    const run = vi.spyOn(orchestrator as unknown as { runWithEscalation(job: Job): Promise<Job> }, "runWithEscalation").mockImplementation(async job => queue.transition(job.id, status)!);
    await orchestrator.runBatch(work.id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.get(work.id)?.status).toBe("PENDING");
    expect(orchestrator.isProjectRunning("project")).toBe(false);
    await expect(orchestrator.withProjectGitAction("project", async () => "pushed")).resolves.toBe("pushed");
  });
  it("honors human review between setup and implementation", async () => {
    const { project, queue } = setup(); writeFileSync(join(project, "app.py"), "");
    const work = queue.create("project", project, [{ description: "Implement a feature" }]);
    const orchestrator = new Orchestrator(queue); orchestrator.configureHumanReview(() => true);
    const run = vi.spyOn(orchestrator as unknown as { runWithEscalation(job: Job): Promise<Job> }, "runWithEscalation").mockImplementation(async job => queue.transition(job.id, "SUCCESS")!);
    const completed = await orchestrator.run(work.id);
    expect(completed).toMatchObject({ kind: "linter_setup", awaitingHumanReview: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.get(work.id)?.status).toBe("PENDING");
    expect(orchestrator.isProjectRunning("project")).toBe(false);
  });
  it("records a setup startup error on setup while leaving a single implementation pending", async () => {
    const { project, queue } = setup(); writeFileSync(join(project, "app.py"), "");
    const work = queue.create("project", project, [{ description: "Implement a feature" }]);
    const orchestrator = new Orchestrator(queue);
    vi.spyOn(orchestrator as unknown as { runWithEscalation(job: Job): Promise<Job> }, "runWithEscalation").mockRejectedValue(new Error("Setup could not start"));
    const result = await orchestrator.run(work.id);
    expect(result).toMatchObject({ kind: "linter_setup", status: "FAILED", error: "Setup could not start" });
    expect(queue.get(work.id)?.status).toBe("PENDING");
    expect(orchestrator.isProjectRunning("project")).toBe(false);
  });
});
