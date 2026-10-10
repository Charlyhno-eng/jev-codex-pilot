import { mkdtempSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  handler: undefined as unknown as (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  configFile: ""
}));
vi.mock("node:http", () => ({ createServer: (handler: typeof server.handler) => {
  server.handler = handler;
  return { listen: vi.fn() };
} }));
vi.mock("../../src/core/app-config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/core/app-config.js")>();
  return { ...actual, AppConfigStore: class extends actual.AppConfigStore {
    constructor() { super(server.configFile); }
  } };
});
vi.mock("../../src/core/single-instance.js", () => ({ acquireApiInstance: vi.fn() }));
vi.mock("../../src/core/queue.js", () => ({ JobQueue: class { flush() {} } }));
vi.mock("../../src/core/projects.js", () => ({ ProjectStore: class {} }));
vi.mock("../../src/core/attachments.js", () => ({ AttachmentStore: class {} }));
vi.mock("../../src/core/orchestrator.js", () => ({ Orchestrator: class { configureGitDelivery() {} configureHumanReview() {} } }));

async function request(method: string, path: string, input?: unknown, headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:5173" }) {
  const incoming = {
    method, url: path, headers,
    async *[Symbol.asyncIterator]() { if (input !== undefined) yield JSON.stringify(input); }
  } as unknown as IncomingMessage;
  const response = { writeHead: vi.fn(), end: vi.fn() };
  await server.handler(incoming, response as unknown as ServerResponse);
  return { status: response.writeHead.mock.calls[0][0], body: JSON.parse(response.end.mock.calls[0][0]) as unknown };
}

beforeEach(async () => {
  server.configFile = join(mkdtempSync(join(tmpdir(), "jev-api-settings-")), "config.toml");
  vi.resetModules();
  await import("../../src/api/server.js");
});

describe("provider settings API", () => {
  it.each([
    { host: "attacker.example:3000" },
    { host: "localhost:3000", origin: "https://attacker.example" },
    { host: "localhost:3000", origin: "null" },
    { host: "localhost:3000", origin: "http://localhost:9999" },
    { host: "localhost:3000", "sec-fetch-site": "cross-site" }
  ])("blocks external reads, writes, and preflights before accessing credentials: %j", async headers => {
    await request("PUT", "/api/settings", { apiKey: "saved-key" });
    for (const method of ["GET", "PUT", "OPTIONS"]) {
      expect((await request(method, method === "GET" ? "/api/settings/secrets" : "/api/settings", { apiKey: "overwritten" }, headers)).status).toBe(403);
    }
    expect((await request("GET", "/api/settings/secrets")).body).toEqual({ apiKey: "saved-key" });
  });

  it("allows CLI settings checks while requiring a browser origin for private credentials", async () => {
    const headers = { host: "127.0.0.1:3000" };
    expect((await request("GET", "/api/settings", undefined, headers)).status).toBe(200);
    expect((await request("GET", "/api/settings/secrets", undefined, headers)).status).toBe(403);
    expect(server.handler).toBeDefined();
    expect((await request("GET", "/api/settings")).status).toBe(200);
    const response = { writeHead: vi.fn(), end: vi.fn() };
    await server.handler({ method: "GET", url: "/api/settings", headers } as IncomingMessage, response as unknown as ServerResponse);
    expect(response.writeHead.mock.calls[0][1]).not.toHaveProperty("Access-Control-Allow-Origin");
  });

  it.each([null, [], 42, "invalid"])("returns a client error for non-object JSON: %j", async input => {
    expect((await request("PUT", "/api/settings", input)).status).toBe(400);
  });
  it("reads unconfigured settings and an empty API key", async () => {
    expect(await request("GET", "/api/settings")).toEqual({ status: 200, body: { configured: false, maskedApiKey: "" } });
    expect(await request("GET", "/api/settings/secrets")).toEqual({ status: 200, body: { apiKey: "" } });
  });

  it("saves a trimmed API key and masks it in public settings", async () => {
    const publicSettings = { status: 200, body: { configured: true, maskedApiKey: "••••••••" } };
    expect(await request("PUT", "/api/settings", { apiKey: "  test-provider-key  " })).toEqual(publicSettings);
    expect(await request("GET", "/api/settings")).toEqual(publicSettings);
    expect(await request("GET", "/api/settings/secrets")).toEqual({ status: 200, body: { apiKey: "test-provider-key" } });
    expect(readFileSync(server.configFile, "utf8")).toContain('api_key = "test-provider-key"');
  });

  it.each([{}, { apiKey: "" }, { apiKey: "  " }, { apiKey: 123 }])("rejects invalid updates without overwriting the saved key: %j", async input => {
    await request("PUT", "/api/settings", { apiKey: "saved-key" });
    expect((await request("PUT", "/api/settings", input)).status).toBe(400);
    expect(await request("GET", "/api/settings/secrets")).toEqual({ status: 200, body: { apiKey: "saved-key" } });
  });
});
