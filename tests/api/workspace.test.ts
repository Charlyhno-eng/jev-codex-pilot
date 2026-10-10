import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Job } from "../../src/core/types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", ticketBusy: false, gitBusy: false, ticketReserved: false, humanInTheLoop: false, pushes: 0, review: false, singleRun: vi.fn(), runs: vi.fn(), setup: vi.fn(), prepare: vi.fn(), approval: vi.fn(), jobs: [] as Job[], handler: undefined as unknown as (req: IncomingMessage, res: ServerResponse) => Promise<void> }));
vi.mock("node:http", () => ({ createServer: (handler: typeof state.handler) => { state.handler = handler; return { listen: vi.fn() }; } }));
vi.mock("../../src/core/single-instance.js", () => ({ acquireApiInstance: vi.fn() }));
vi.mock("../../src/core/queue.js", () => ({ JobQueue: class { flush() {} get(id: string) { return state.jobs.find(job => job.id === id); } createBatch(projectId: string, projectPath: string, tasks: Job["tasks"]) { const jobs = tasks.map((task, index): Job => ({ id: `new-${index}`, projectId, projectPath, tasks: [task], status: "PENDING", attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })); state.jobs.push(...jobs); return jobs; } update(id: string, patch: Partial<Job>) { const job = this.get(id)!; Object.assign(job, patch); return job; } list() { return state.jobs; } listProjectExecutionOrder(id: string) { return state.jobs.filter(job => job.projectId === id); } } }));
vi.mock("../../src/core/projects.js", () => ({ ProjectStore: class { touch() {} hasAgents() { return true; } get(id: string) { return id === "project" ? { id, path: state.root, linterEnabled: true, humanInTheLoop: state.humanInTheLoop } : undefined; } setHumanInTheLoop(id: string, humanInTheLoop: boolean) { state.humanInTheLoop = humanInTheLoop; return { ...this.get(id), humanInTheLoop }; } } }));
vi.mock("../../src/core/app-config.js", () => ({ AppConfigStore: class {}, maskedApiKey: vi.fn() }));
vi.mock("../../src/core/attachments.js", () => ({ AttachmentStore: class { validate() {} saveForJob() { return []; } } }));
vi.mock("../../src/core/orchestrator.js", () => ({ Orchestrator: class { configureGitDelivery() {} configureHumanReview() {} ownsTicketRun() { return state.ticketReserved; } approveHumanReview() { if (state.ticketBusy) throw new Error("Wait for the active ticket"); state.approval(); } prepare(job: Job) { state.prepare(job); return Promise.resolve(job); } needsHumanReview() { return state.review; } async runBatch(id: string) { state.runs(id); } async run(id: string) { await state.singleRun(id); } isProjectRunning() { return state.ticketBusy || state.gitBusy; } isProjectGitActionRunning() { return state.gitBusy; } async withProjectGitAction(_id: string, run: () => Promise<unknown>) { return run(); } } }));

vi.mock("../../src/core/project-linter.js", async importOriginal => ({ ...await importOriginal<typeof import("../../src/core/project-linter.js")>(), ensureProjectLinterTicket: (...args: unknown[]) => state.setup(...args) }));
vi.mock("../../src/core/git-workspace.js", () => ({ readGitWorkspace: () => ({ branch: "main" }), selectGitBranch: vi.fn(), pushGitBranch: () => { state.pushes++; return { branch: "main", remote: "origin" }; } }));

async function request(method: string, path: string, headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:5173" }, body?: unknown) {
  const req = { method, url: path, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } } as unknown as IncomingMessage;
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await state.handler(req, res as unknown as ServerResponse);
  return { status: res.writeHead.mock.calls[0][0], body: JSON.parse(res.end.mock.calls[0][0]) };
}

beforeAll(async () => {
  state.root = mkdtempSync(join(tmpdir(), "jev-workspace-api-"));
  writeFileSync(join(state.root, "app.ts"), "export const message = 'hello';");
  writeFileSync(join(state.root, ".env"), "SECRET=hidden");
  await import("../../src/api/server.js");
});
afterAll(() => rmSync(state.root, { recursive: true, force: true }));

describe("workspace API", () => {
  it("allows disabling human review during execution without approving an active ticket", async () => {
    state.ticketBusy = true;
    state.approval.mockClear();
    try {
      const result = await request("PUT", "/api/projects/project", undefined, { humanInTheLoop: false });
      expect(result.status).toBe(200);
      expect(result.body.humanInTheLoop).toBe(false);
      expect(state.approval).not.toHaveBeenCalled();
    } finally { state.ticketBusy = false; }
  });
  it("pushes completed work directly, including projects with the legacy linter preference", async () => {
    const path = "/api/projects/project";
    expect((await request("PUT", path, undefined, { linterEnabled: true })).status).toBe(400);
    expect(await request("POST", `${path}/git/push`)).toEqual({ status: 200, body: { branch: "main", remote: "origin" } });
    expect(state.pushes).toBe(1);
    expect(state.setup).not.toHaveBeenCalled();
  });
  it("reports Git activity accurately and allows pushing after it finishes", async () => {
    const path = "/api/projects/project/git";
    state.gitBusy = true;
    expect((await request("GET", path)).body.busy).toBe(true);
    expect((await request("POST", `${path}/push`)).body.error).toContain("A Git action");
    state.gitBusy = false; state.ticketBusy = true;
    expect((await request("POST", `${path}/push`)).body.error).toContain("active ticket");
    state.ticketBusy = false;
    expect((await request("GET", path)).body.busy).toBe(false);
    expect((await request("POST", `${path}/push`)).status).toBe(200);
  });
  it("checks lint setup when an existing project is opened", async () => {
    expect((await request("GET", "/api/projects/project")).status).toBe(200);
    expect(state.setup).toHaveBeenCalledWith(expect.anything(), "project", state.root, false);
  });
  it("lists safe files and exposes a read-only source endpoint", async () => {
    expect((await request("GET", "/api/projects/project/files")).body.files.map((file: { path: string }) => file.path)).toEqual(["app.ts"]);
    expect((await request("GET", "/api/projects/project/files?path=app.ts")).body.content).toBe("export const message = 'hello';");
    for (const method of ["PUT", "POST", "DELETE"]) expect((await request(method, "/api/projects/project/files?path=app.ts")).status).toBe(405);
  });
  it("rejects private files, unknown projects, and traversal", async () => {
    expect((await request("GET", "/api/projects/project/files?path=.env")).status).toBe(400);
    expect((await request("GET", "/api/projects/project/files?path=../outside")).status).toBe(400);
    expect((await request("GET", "/api/projects/missing/files")).status).toBe(404);
  });
  it.each([
    { host: "localhost:3000" },
    { host: "evil.example:3000", origin: "http://localhost:5173" },
    { host: "localhost:3000", origin: "https://evil.example" },
    { host: "localhost:3000", origin: "http://localhost:9999" },
    { host: "localhost:3000", origin: "http://localhost:5173", "sec-fetch-site": "cross-site" }
  ])("rejects untrusted shell starts before spawning: %j", async headers => {
    expect((await request("POST", "/api/projects/project/terminal", headers)).status).toBe(403);
    expect((await request("GET", "/api/projects/project/terminal")).body).toEqual([]);
  });
  it("accepts browser GET requests with a local Referer without starting a shell", async () => {
    expect(await request("GET", "/api/projects/project/terminal", { host: "127.0.0.1:3000", referer: "http://localhost:5173/projects/project/ide" })).toEqual({ status: 200, body: [] });
  });
});


describe("lightweight ticket API", () => {
  beforeAll(() => {
    state.jobs = ["older", "live", "foreign"].map((id, index): Job => ({
      id, projectId: id === "foreign" ? "removed-project" : "project", projectPath: state.root,
      tasks: [{ description: id }], createdAt: `2026-10-08T12:00:0${index}.000Z`,
      updatedAt: "2026-10-08T12:00:05.000Z", status: id === "live" ? "RUNNING" : "SUCCESS", attempts: 1,
      output: `private logs for ${id}`,
      execution: { phase: "IMPLEMENTING", model: "sol", reasoning: "low", startedAt: "2026-10-08T12:00:00.000Z", lastActivityAt: "2026-10-08T12:00:05.000Z", verification: "not_run", events: [{ id: `event-${id}`, kind: "command", title: "Command", detail: "Long command output", timestamp: "2026-10-08T12:00:05.000Z", status: "success" }] }
    }));
  });
  it("omits all logs from summaries while preserving full default responses", async () => {
    const full = (await request("GET", "/api/jobs")).body as Job[];
    const summary = (await request("GET", "/api/jobs?view=summary&projectId=project")).body as Job[];
    expect(full).toHaveLength(2);
    expect(full[0].output).toContain("private logs");
    expect(summary).toHaveLength(2);
    for (const job of summary) {
      expect(job).not.toHaveProperty("output");
      expect(job.execution?.events).toEqual([]);
      expect(job.tasks).toHaveLength(1);
    }
    expect(state.jobs[0].execution?.events).toHaveLength(1);
  });
  it("includes logs only for the selected console ticket and resolves the active fallback", async () => {
    for (const detailId of ["latest", "missing", "live"]) {
      const jobs = (await request("GET", `/api/jobs?view=summary&projectId=project&detailId=${detailId}`)).body as Job[];
      expect(jobs.find(job => job.id === "live")?.output).toBe("private logs for live");
      expect(jobs.find(job => job.id === "older")).not.toHaveProperty("output");
    }
    const jobs = (await request("GET", "/api/jobs?view=summary&detailId=older")).body as Job[];
    expect(jobs.find(job => job.id === "older")?.execution?.events).toHaveLength(1);
    expect(jobs.find(job => job.id === "live")).not.toHaveProperty("output");
  });
  it("sends only the fields needed by the favicon", async () => {
    expect((await request("GET", "/api/jobs?view=status")).body).toEqual([
      { id: "older", projectId: "project", status: "SUCCESS" },
      { id: "live", projectId: "project", status: "RUNNING" }
    ]);
  });
});


describe("ticket submission execution", () => {
  it("rejects malformed task descriptions without creating work", async () => {
    state.jobs = [];
    for (const tasks of [[null], [{ description: 42 }], [{}], "invalid"]) {
      expect((await request("POST", "/api/jobs", undefined, { projectId: "project", tasks, run: true })).status).toBe(400);
      expect(state.jobs).toEqual([]);
    }
  });

  it("refreshes an explicit re-evaluation but reuses ordinary preparation", async () => {
    state.jobs = [{ id: "reevaluate", projectId: "project", projectPath: state.root, tasks: [{ description: "Read" }], status: "PENDING", attempts: 0, createdAt: "", updatedAt: "", analysis: { complexity: 1, model: "luna", reasoning: "medium", task_types: ["research"], rationale: [], evaluator: "typesafe-ai/jev" } }];
    state.prepare.mockClear();
    expect((await request("POST", "/api/jobs/reevaluate/prepare")).status).toBe(200);
    expect(state.prepare.mock.calls[0][0].analysis).toBeDefined();
    expect((await request("POST", "/api/jobs/reevaluate/prepare", undefined, { reevaluate: true })).status).toBe(200);
    expect(state.prepare.mock.calls[1][0].analysis).toBeUndefined();
  });

  it("protects the selected ticket during preparation while allowing other pending edits", async () => {
    state.jobs = [{ id: "reserved", projectId: "project", projectPath: state.root, tasks: [{ description: "Read" }], status: "PENDING", attempts: 0, createdAt: "", updatedAt: "" }];
    state.ticketReserved = true;
    try {
      for (const action of ["skip", "remove", "edit", "adjust"]) {
        expect((await request("POST", `/api/jobs/reserved/${action}`, undefined, { description: "Changed", dimension: "model", delta: 1 })).status).toBe(409);
      }
      expect(state.jobs[0].tasks[0].description).toBe("Read");
      expect(state.jobs[0].status).toBe("PENDING");
    } finally { state.ticketReserved = false; }
    state.jobs[0].status = "RUNNING";
    expect((await request("POST", "/api/jobs/reserved/skip")).status).toBe(409);
  });

  it("refuses launching history belonging to a removed project", async () => {
    state.jobs = [{ id: "removed", projectId: "removed-project", projectPath: state.root, tasks: [{ description: "Read" }], status: "PENDING", attempts: 0, createdAt: "", updatedAt: "" }];
    state.runs.mockClear();
    expect((await request("POST", "/api/jobs/removed/run-batch")).status).toBe(404);
    expect(state.runs).not.toHaveBeenCalled();
  });
  it("launches the existing pending linter setup without creating another ticket", async () => {
    state.jobs = [{ id: "setup", kind: "linter_setup", projectId: "project", projectPath: state.root, tasks: [{ description: "Set up project linters" }], status: "PENDING", attempts: 0, createdAt: "", updatedAt: "" }];
    state.runs.mockClear();
    expect((await request("POST", "/api/jobs/setup/run-batch")).status).toBe(202);
    expect(state.runs).toHaveBeenCalledWith("setup");
    expect(state.jobs).toHaveLength(1);
  });
  it("continues newly submitted work after an explicitly launched single ticket", async () => {
    state.jobs = [{ id: "first", projectId: "project", projectPath: state.root, tasks: [{ description: "First" }], status: "PENDING", attempts: 0, createdAt: "", updatedAt: "" }];
    state.runs.mockClear();
    let finish!: () => void;
    state.singleRun.mockImplementationOnce(() => {
      state.ticketBusy = true;
      return new Promise<void>(resolve => { finish = () => { state.jobs[0].status = "SUCCESS"; state.ticketBusy = false; resolve(); }; });
    });
    expect((await request("POST", "/api/jobs/first/run")).status).toBe(202);
    expect((await request("POST", "/api/jobs", undefined, { projectId: "project", run: true, tasks: [{ description: "Second" }] })).status).toBe(201);
    expect(state.runs).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(state.runs).toHaveBeenCalledWith("new-0"));
  });
  it.each([
    { run: true, busy: false, review: false, paused: false, expected: 1 },
    { run: true, busy: true, review: false, paused: false, expected: 0 },
    { run: true, busy: false, review: true, paused: false, expected: 0 },
    { run: true, busy: false, review: false, paused: true, expected: 0 },
    { run: false, busy: false, review: false, paused: false, expected: 0 }
  ])("starts an idle queue only when execution is requested and unpaused: %j", async scenario => {
    state.jobs = scenario.paused ? [{ id: "paused", projectId: "project", projectPath: state.root, tasks: [{ description: "Paused" }], status: "SESSION_PAUSED", attempts: 1, createdAt: "", updatedAt: "" }] : [];
    state.ticketBusy = scenario.busy; state.review = scenario.review;
    state.runs.mockClear();
    try {
      const result = await request("POST", "/api/jobs", undefined, { projectId: "project", run: scenario.run, tasks: [{ description: "Read docs" }] });
      expect(result.status).toBe(201);
      expect(state.runs).toHaveBeenCalledTimes(scenario.expected);
      expect(state.jobs.at(-1)?.status).toBe("PENDING");
    } finally { state.ticketBusy = false; state.review = false; }
  });
});
