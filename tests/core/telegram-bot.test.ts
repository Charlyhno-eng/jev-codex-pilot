import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/core/app-config.js";
import { TelegramBot } from "../../src/core/telegram-bot.js";
import type { TelegramAction } from "../../src/core/telegram-ui.js";
import type { Job, ProjectRecord } from "../../src/core/types.js";

const config: AppConfig = { jevProvider: "vercel-ai-gateway", aiGatewayApiKey: "", telegramBotToken: "private-token", telegramAllowedChatId: "42", telegramEnabled: true };
const project: ProjectRecord = { id: "project-a", name: "Example", path: "/example", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const pendingJob = (description = "Pending work"): Job => ({ id: "job-a", projectId: project.id, projectPath: project.path, tasks: [{ description }], status: "PENDING", createdAt: "", updatedAt: "", attempts: 0 });

function telegramMock(options: { updates?: unknown[]; firstMessageId?: number } = {}) {
  let nextMessageId = options.firstMessageId ?? 100;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split("/").at(-1);
    const payload = JSON.parse(String(init?.body ?? "{}"));
    let result: unknown = true;
    if (method === "getUpdates") result = options.updates ?? [];
    if (method === "sendMessage") result = { message_id: nextMessageId++, chat: { id: Number(payload.chat_id) }, text: payload.text };
    if (method === "editMessageText") result = { message_id: payload.message_id, chat: { id: Number(payload.chat_id) }, text: payload.text };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  });
}

function active(bot: TelegramBot) {
  return (bot as any).state.activeViewByChat["42"] as { messageId: number; revision: number; view: string };
}

async function click(bot: TelegramBot, action: TelegramAction, argument?: string, snapshot = active(bot)) {
  await (bot as any).handleUpdate(config, {
    update_id: 10,
    callback_query: { id: `callback-${action}`, data: `${snapshot.revision}|${action}|${argument ?? ""}`, message: { message_id: snapshot.messageId, chat: { id: 42 } } }
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Telegram bot", () => {
  it("sends one private completion summary after development finishes", async () => {
    const fetchMock = telegramMock();
    vi.stubGlobal("fetch", fetchMock);
    const bot = new TelegramBot({ config: () => config, listProjects: () => [project], listJobs: () => [], createTicket: () => { throw new Error("not expected"); } }, mkdtempSync(join(tmpdir(), "jev-telegram-")));
    await bot.notifyDevelopmentFinished(project, [{ ...pendingJob(), status: "SUCCESS" }, { ...pendingJob(), id: "failed", status: "FAILED" }]);
    const sent = fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/sendMessage"));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0][1]?.body))).toMatchObject({ chat_id: "42", text: expect.stringContaining("1 completed · 1 failed") });
  });
  it("pairs only from /start, clears that chat, and opens the dashboard", async () => {
    const fetchMock = telegramMock();
    vi.stubGlobal("fetch", fetchMock);
    const unpaired = { ...config, telegramAllowedChatId: "", telegramEnabled: false };
    const paired: string[] = [];
    const bot = new TelegramBot({ config: () => unpaired, listProjects: () => [project], listJobs: () => [], createTicket: () => { throw new Error("not expected"); }, pairChat: chatId => paired.push(chatId) }, mkdtempSync(join(tmpdir(), "jev-telegram-")));

    await (bot as any).handleUpdate(unpaired, { update_id: 1, message: { message_id: 5, chat: { id: 42 }, text: "/start" } });

    expect(paired).toEqual(["42"]);
    const calls = fetchMock.mock.calls.map(call => ({ method: String(call[0]).split("/").at(-1), body: JSON.parse(String(call[1]?.body ?? "{}")) }));
    expect(calls.find(call => call.method === "deleteMessages")?.body.message_ids).toEqual([5, 4, 3, 2, 1]);
    expect(calls.find(call => call.method === "sendMessage")?.body.text).toContain("Bot enabled");
  });

  it("clears every known message in batches when the service starts", async () => {
    const fetchMock = telegramMock({ updates: [{ update_id: 8, message: { message_id: 230, chat: { id: 42 }, text: "waiting while offline" } }], firstMessageId: 231 });
    vi.stubGlobal("fetch", fetchMock);
    const bot = new TelegramBot({ config: () => config, listProjects: () => [project], listJobs: () => [], createTicket: () => { throw new Error("not expected"); } }, mkdtempSync(join(tmpdir(), "jev-telegram-")));

    await (bot as any).bootstrap();

    const deletionCalls = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith("/deleteMessages"))
      .map(call => JSON.parse(String(call[1]?.body)).message_ids as number[]);
    expect(deletionCalls.map(ids => ids.length)).toEqual([100, 100, 31]);
    expect(deletionCalls.flat()).toEqual(Array.from({ length: 231 }, (_, index) => 231 - index));
    expect(active(bot).view).toBe("home");
  });

  it("creates a ticket through the current buttons and deletes the user's description from chat", async () => {
    const created: string[] = [];
    const fetchMock = telegramMock();
    vi.stubGlobal("fetch", fetchMock);
    const bot = new TelegramBot({
      config: () => config,
      listProjects: () => [project],
      listJobs: () => [],
      createTicket: (_project, description) => { created.push(description); return pendingJob(description); }
    }, mkdtempSync(join(tmpdir(), "jev-telegram-")));

    await (bot as any).handleUpdate(config, { update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: "/start" } });
    await click(bot, "new");
    await click(bot, "ticket", project.id);
    await (bot as any).handleUpdate(config, { update_id: 4, message: { message_id: 101, chat: { id: 42 }, text: "Add a project progress command" } });

    expect(created).toEqual(["Add a project progress command"]);
    expect(active(bot).view).toBe("created");
    const deletedDescription = fetchMock.mock.calls.some(call => String(call[0]).endsWith("/deleteMessages") && JSON.parse(String(call[1]?.body)).message_ids.includes(101));
    expect(deletedDescription).toBe(true);
  });

  it("only offers Codex launch from a project that currently has pending tickets", async () => {
    const launched: string[] = [];
    vi.stubGlobal("fetch", telegramMock());
    const pending = pendingJob();
    const bot = new TelegramBot({ config: () => config, listProjects: () => [project], listJobs: () => [pending], createTicket: () => pending, runPending: selected => { launched.push(selected.id); return "started"; } }, mkdtempSync(join(tmpdir(), "jev-telegram-")));

    await (bot as any).handleUpdate(config, { update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: "/start" } });
    await click(bot, "run-menu");
    expect(active(bot).view).toBe("run-project");
    await click(bot, "run", project.id);

    expect(launched).toEqual([project.id]);
    expect(active(bot).view).toBe("home");
  });

  it("cancels creation only from the current inline screen", async () => {
    vi.stubGlobal("fetch", telegramMock());
    const bot = new TelegramBot({ config: () => config, listProjects: () => [project], listJobs: () => [], createTicket: () => { throw new Error("not expected"); } }, mkdtempSync(join(tmpdir(), "jev-telegram-")));

    await (bot as any).handleUpdate(config, { update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: "/start" } });
    await click(bot, "new");
    await click(bot, "ticket", project.id);
    await click(bot, "cancel");

    expect((bot as any).state.awaitingTicketProjectByChat["42"]).toBeUndefined();
    expect(active(bot).view).toBe("home");
  });

  it("rejects buttons from an older screen revision", async () => {
    const fetchMock = telegramMock();
    vi.stubGlobal("fetch", fetchMock);
    const bot = new TelegramBot({ config: () => config, listProjects: () => [project], listJobs: () => [], createTicket: () => { throw new Error("not expected"); } }, mkdtempSync(join(tmpdir(), "jev-telegram-")));

    await (bot as any).handleUpdate(config, { update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: "/start" } });
    const oldHome = { ...active(bot) };
    await click(bot, "new");
    await click(bot, "projects", undefined, oldHome);

    expect(active(bot).view).toBe("new-project");
    const callbackAnswers = fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/answerCallbackQuery")).map(call => JSON.parse(String(call[1]?.body)));
    expect(callbackAnswers.at(-1)?.text).toContain("no longer active");
  });

  it("permanently removes only the newly created pending ticket after confirmation", async () => {
    const jobs: Job[] = [];
    const removed: string[] = [];
    vi.stubGlobal("fetch", telegramMock());
    const bot = new TelegramBot({
      config: () => config,
      listProjects: () => [project],
      listJobs: () => jobs,
      createTicket: (_project, description) => { const job = pendingJob(description); jobs.push(job); return job; },
      removeTicket: jobId => { const index = jobs.findIndex(job => job.id === jobId && job.status === "PENDING"); if (index < 0) return undefined; removed.push(jobId); return jobs.splice(index, 1)[0]; }
    }, mkdtempSync(join(tmpdir(), "jev-telegram-")));

    await (bot as any).handleUpdate(config, { update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: "/start" } });
    await click(bot, "new");
    await click(bot, "ticket", project.id);
    await (bot as any).handleUpdate(config, { update_id: 4, message: { message_id: 101, chat: { id: 42 }, text: "Disposable ticket" } });
    await click(bot, "delete-request", "job-a");
    expect(active(bot).view).toBe("delete-confirm");
    await click(bot, "delete-confirm", "job-a");

    expect(removed).toEqual(["job-a"]);
    expect(jobs).toEqual([]);
    expect(active(bot).view).toBe("home");
  });
});
