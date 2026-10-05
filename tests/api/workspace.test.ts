import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", handler: undefined as unknown as (req: IncomingMessage, res: ServerResponse) => Promise<void> }));
vi.mock("node:http", () => ({ createServer: (handler: typeof state.handler) => { state.handler = handler; return { listen: vi.fn() }; } }));
vi.mock("../../src/core/single-instance.js", () => ({ acquireApiInstance: vi.fn() }));
vi.mock("../../src/core/queue.js", () => ({ JobQueue: class {} }));
vi.mock("../../src/core/projects.js", () => ({ ProjectStore: class { get(id: string) { return id === "project" ? { id, path: state.root } : undefined; } } }));
vi.mock("../../src/core/app-config.js", () => ({ AppConfigStore: class {}, maskedApiKey: vi.fn() }));
vi.mock("../../src/core/attachments.js", () => ({ AttachmentStore: class {} }));
vi.mock("../../src/core/orchestrator.js", () => ({ Orchestrator: class { configureGitDelivery() {} configureHumanReview() {} } }));

async function request(method: string, path: string, headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:5173" }) {
  const req = { method, url: path, headers, async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage;
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
