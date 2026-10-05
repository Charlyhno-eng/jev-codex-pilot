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
vi.mock("../../src/core/queue.js", () => ({ JobQueue: class {} }));
vi.mock("../../src/core/projects.js", () => ({ ProjectStore: class {} }));
vi.mock("../../src/core/attachments.js", () => ({ AttachmentStore: class {} }));
vi.mock("../../src/core/orchestrator.js", () => ({ Orchestrator: class { configureGitDelivery() {} configureHumanReview() {} } }));

async function request(method: string, path: string, input?: unknown) {
  const incoming = {
    method, url: path, headers: { host: "localhost" },
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
