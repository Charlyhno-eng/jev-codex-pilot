import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Job } from "../../src/core/types.js";
import type { SkillStore } from "../../src/core/skills.js";

const state = vi.hoisted(() => ({ root: "", handler: undefined as unknown as (req: IncomingMessage, res: ServerResponse) => Promise<void>, runs: 0 }));
vi.mock("node:http", () => ({ createServer: (handler: typeof state.handler) => { state.handler = handler; return { listen: vi.fn() }; } }));
vi.mock("../../src/core/single-instance.js", () => ({ acquireApiInstance: vi.fn() }));
vi.mock("../../src/core/skills.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/core/skills.js")>();
  return { ...actual, SkillStore: class extends actual.SkillStore { constructor() { super(join(state.root, "skills")); } } };
});
vi.mock("../../src/core/queue.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/core/queue.js")>();
  return { ...actual, JobQueue: class extends actual.JobQueue { constructor() { super(join(state.root, "queue")); } } };
});
vi.mock("../../src/core/projects.js", () => ({ ProjectStore: class { get(id: string) { return ["first", "second"].includes(id) ? { id, path: join(state.root, "target", id) } : undefined; } hasAgents() { return true; } touch() {} } }));
vi.mock("../../src/core/app-config.js", () => ({ AppConfigStore: class {}, maskedApiKey: vi.fn() }));
vi.mock("../../src/core/attachments.js", () => ({ AttachmentStore: class { validate() {} saveForJob() { return []; } removeForJob() {} } }));
vi.mock("../../src/core/orchestrator.js", () => ({ Orchestrator: class { configureGitDelivery() {} configureHumanReview() {} isProjectRunning() { return false; } async prepare(job: Job) { return job; } run() { state.runs++; } runBatch() { state.runs++; } } }));
async function request(method: string, path: string, input?: unknown, trusted = true) {
  const req = { method, url: path, headers: trusted ? { host: "localhost:3000", origin: "http://localhost:5173" } : { host: "localhost:3000", origin: "https://example.com" }, async *[Symbol.asyncIterator]() { if (input !== undefined) yield JSON.stringify(input); } } as unknown as IncomingMessage;
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await state.handler(req, res as unknown as ServerResponse);
  return { status: res.writeHead.mock.calls[0][0], body: JSON.parse(res.end.mock.calls[0][0]) };
}
function skillFiles() { return [{ path: "SKILL.md", base64: Buffer.from('---\nname: imported-layout\ndescription: Improve layout\n---\n# Layout\nUse deliberate whitespace.').toString("base64") }]; }
beforeAll(async () => { state.root = mkdtempSync(join(tmpdir(), "jev-skills-api-")); await import("../../src/api/server.js"); });
afterAll(() => rmSync(state.root, { recursive: true, force: true }));

describe("skills API and ticket attachment lifecycle", () => {
  it("exposes advanced guidance in the library, previews, and frozen ticket summaries", async () => {
    const id = "builtin-rust-low-level-performance";
    const library = (await request("GET", "/api/skills")).body;
    const skill = library.find((item: { id: string }) => item.id === id);
    expect(skill.caution).toBeDefined();
    expect((await request("GET", `/api/skills/${id}`)).body.caution).toEqual(skill.caution);
    const created = await request("POST", "/api/jobs", { projectId: "second", tasks: [{ description: "Optimize a Rust hotspot", skillIds: [id] }] });
    expect(created.status).toBe(201);
    const job = created.body[0];
    expect(job.skills[0].caution).toEqual(skill.caution);
    const summaries = (await request("GET", "/api/jobs?view=summary&projectId=second")).body;
    const saved = summaries.find((item: { id: string }) => item.id === job.id).skills[0];
    expect(saved.caution).toEqual(skill.caution);
    expect(saved).not.toHaveProperty("content");
    expect(saved).not.toHaveProperty("path");
    expect(state.runs).toBe(0);
  });
  it("returns detected project languages without starting ticket execution", async () => {
    const path = join(state.root, "target", "first");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "main.ts"), "");
    writeFileSync(join(path, "main.py"), "");
    const result = await request("GET", "/api/projects/first");
    expect(result.status).toBe(200);
    expect(result.body.languages).toEqual(["Python", "TypeScript"]);
    const queued = (await request("GET", "/api/jobs?projectId=first")).body as Job[];
    expect(queued.find(job => job.kind === "linter_setup")).toMatchObject({ status: "PENDING" });
    expect((await request("GET", "/api/projects/missing")).status).toBe(404);
    expect(state.runs).toBe(0);
  });
  it("shares imports across projects and preserves frozen copies when editing after library removal", async () => {
    expect((await request("GET", "/api/skills")).body).toHaveLength(13);
    const imported = await request("POST", "/api/skills", { files: skillFiles() });
    expect(imported.status).toBe(201);
    expect(imported.body).not.toHaveProperty("files");
    const id = imported.body.id;
    expect((await request("GET", `/api/skills/${id}`)).body.content).toContain("deliberate whitespace");
    const first = await request("POST", "/api/jobs", { projectId: "first", tasks: [{ description: "Design first", skillIds: [id] }, { description: "Plain next" }] });
    const second = await request("POST", "/api/jobs", { projectId: "second", tasks: [{ description: "Design second", skillIds: [id] }] });
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    const selected = first.body[0] as Job;
    expect(selected.skills?.[0].content).toContain("deliberate whitespace");
    expect(second.body[0].skills[0].path).not.toBe(selected.skills![0].path);
    expect(first.body[1].skills).toEqual([]);
    const summary = ((await request("GET", "/api/jobs?view=summary&projectId=first")).body as Job[]).find(job => job.id === selected.id)!;
    expect(summary.skills[0]).not.toHaveProperty("content");
    expect(summary.skills[0]).not.toHaveProperty("path");
    await request("DELETE", `/api/skills/${id}`);
    expect((await request("GET", `/api/skills/${id}`)).status).toBe(404);
    const edited = await request("POST", `/api/jobs/${selected.id}/edit`, { description: "Refine first", skillIds: [id] });
    expect(edited.status).toBe(200);
    expect(edited.body.skills).toEqual(selected.skills);
    const removed = await request("POST", `/api/jobs/${selected.id}/edit`, { description: "Refine first", skillIds: [] });
    expect(removed.body.skills).toEqual([]);
    expect(state.runs).toBe(0);
  });
  it("validates selections before creating a batch or changing a pending description", async () => {
    const before = (await request("GET", "/api/jobs")).body.length;
    expect((await request("POST", "/api/jobs", { projectId: "first", tasks: [{ description: "Valid task" }, { description: "Invalid skill", skillIds: ["missing"] }] })).status).toBe(400);
    expect((await request("GET", "/api/jobs")).body).toHaveLength(before);
    const jobs = (await request("GET", "/api/jobs?projectId=first")).body as Job[];
    expect((await request("POST", `/api/jobs/${jobs[0].id}/edit`, { description: "Unwanted edit", skillIds: ["missing"] })).status).toBe(400);
    expect((await request("GET", `/api/jobs/${jobs[0].id}`)).body.tasks).toEqual(jobs[0].tasks);
  });
  it("requires trusted browser origins for imports and deletion and keeps built-ins available", async () => {
    const all = (await request("GET", "/api/skills")).body as ReturnType<SkillStore["list"]>;
    expect((await request("POST", "/api/skills", { files: skillFiles() }, false)).status).toBe(403);
    expect((await request("DELETE", `/api/skills/${all[0].id}`, undefined, false)).status).toBe(403);
    expect((await request("DELETE", `/api/skills/${all[0].id}`)).status).toBe(400);
    expect((await request("GET", "/api/skills")).body).toHaveLength(13);
  });
});
