import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, ProjectRecord } from "../../src/core/types.js";

const mocks = vi.hoisted(() => ({
  config: { jevProvider: "vercel-ai-gateway", aiGatewayApiKey: "test-key", telegramBotToken: "test-token", telegramAllowedChatId: "42", telegramEnabled: true },
  status: "SUCCESS" as Job["status"],
  notify: vi.fn(),
  update: vi.fn(),
  logError: vi.fn(),
  release: vi.fn()
}));

vi.mock("../../src/core/app-config.js", () => ({ AppConfigStore: class { read() { return mocks.config; } } }));
vi.mock("../../src/core/projects.js", () => ({ ProjectStore: class {
  create(path: string) { return { id: "project-1", name: "Example", path, createdAt: "", updatedAt: "" } as ProjectRecord; }
  list() { return []; }
  touch() {}
} }));
vi.mock("../../src/core/queue.js", () => ({ JobQueue: class {
  recoverInterrupted() {}
  list() { return []; }
  create(projectId: string, projectPath: string) { return { id: "ticket-1", projectId, projectPath, tasks: [{ description: "A task" }], status: "PENDING", createdAt: "", updatedAt: "", attempts: 0 } as Job; }
  update = mocks.update;
} }));
vi.mock("../../src/core/orchestrator.js", () => ({ Orchestrator: class {
  async prepare() { return undefined; }
  async run() { return { id: "ticket-1", projectId: "project-1", projectPath: "", tasks: [{ description: "A task" }], status: mocks.status, createdAt: "", updatedAt: "", attempts: 1 } as Job; }
} }));
vi.mock("../../src/core/telegram-bot.js", () => ({ TelegramBot: class { notifyDevelopmentFinished = mocks.notify; } }));
vi.mock("../../src/core/single-instance.js", () => ({ acquireApiInstance: async () => mocks.release }));
vi.mock("../../src/core/jev-logger.js", () => ({ logJevError: mocks.logError }));

import { main } from "../../src/cli/main.js";

const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = "SUCCESS";
  mocks.config.telegramEnabled = true;
  mocks.config.telegramBotToken = "test-token";
  mocks.config.telegramAllowedChatId = "42";
  process.exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode; });

function projectDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "jev-cli-notice-"));
  writeFileSync(join(directory, "AGENTS.md"), "Project instructions.\n");
  return directory;
}

describe("CLI completion notice", () => {
  it.each(["SUCCESS", "FAILED"] as const)("sends the existing Telegram summary for a %s ticket", async status => {
    mocks.status = status;
    await main(["run", "A task"], projectDirectory());
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "project-1" }), [expect.objectContaining({ id: "ticket-1", status })]);
    expect(process.exitCode).toBe(status === "SUCCESS" ? 0 : 1);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("keeps the ticket result and records a failed notice", async () => {
    mocks.notify.mockRejectedValueOnce(new Error("Telegram unavailable"));
    await main(["run", "A task"], projectDirectory());
    expect(mocks.update).toHaveBeenCalledWith("ticket-1", { notificationError: "Telegram unavailable" });
    expect(mocks.logError).toHaveBeenCalledWith("Telegram completion notice failed: Telegram unavailable");
    expect(process.exitCode).toBe(0);
  });

  it("does not notify for a paused ticket or disabled Telegram", async () => {
    mocks.status = "SESSION_PAUSED";
    await main(["run", "A task"], projectDirectory());
    expect(mocks.notify).not.toHaveBeenCalled();
    mocks.status = "SUCCESS";
    mocks.config.telegramEnabled = false;
    await main(["run", "A task"], projectDirectory());
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
