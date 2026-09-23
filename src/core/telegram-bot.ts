import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readDurableJson, writeDurableJson } from "./durable-json.js";
import { join } from "node:path";
import type { AppConfig } from "./app-config.js";
import {
  allowedActions,
  composeTicketScreen,
  createdTicketScreen,
  deleteConfirmationScreen,
  homeScreen,
  newTicketProjectScreen,
  noticeScreen,
  projectScreen,
  projectsScreen,
  runProjectScreen,
  type TelegramAction,
  type TelegramScreen,
  type TelegramView
} from "./telegram-ui.js";
import type { Job, ProjectRecord } from "./types.js";

type TelegramChat = { id: number; type?: string };
type TelegramMessage = { message_id: number; chat: TelegramChat; text?: string };
type TelegramCallback = { id: string; data?: string; message?: TelegramMessage };
type TelegramUpdate = { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallback };
type TelegramReplyMarkup = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
type ActiveView = { messageId: number; revision: number; view: TelegramView };
type CreatedTicket = { jobId: string; projectId: string };
type TelegramState = {
  offset: number;
  awaitingTicketProjectByChat: Record<string, string>;
  activeViewByChat: Record<string, ActiveView>;
  lastCreatedTicketByChat: Record<string, CreatedTicket>;
  highestMessageIdByChat: Record<string, number>;
};

export type TelegramBotDependencies = {
  config: () => AppConfig;
  listProjects: () => ProjectRecord[];
  listJobs: (projectId: string) => Job[];
  createTicket: (project: ProjectRecord, description: string) => Job;
  removeTicket?: (jobId: string) => Job | undefined;
  runPending?: (project: ProjectRecord) => "started" | "empty" | "running";
  pairChat?: (chatId: string) => void;
};

const initialState = (): TelegramState => ({
  offset: 0,
  awaitingTicketProjectByChat: {},
  activeViewByChat: {},
  lastCreatedTicketByChat: {},
  highestMessageIdByChat: {}
});

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const stringMap = (value: unknown) => object(value) && Object.values(value).every(item => typeof item === "string");
const numberMap = (value: unknown) => object(value) && Object.values(value).every(item => typeof item === "number");
function validTelegramState(value: unknown): value is Partial<TelegramState> & { botMessageIdsByChat?: Record<string, number[]> } {
  if (!object(value) || (value.offset !== undefined && !Number.isInteger(value.offset))) return false;
  if (value.awaitingTicketProjectByChat !== undefined && !stringMap(value.awaitingTicketProjectByChat)) return false;
  if (value.highestMessageIdByChat !== undefined && !numberMap(value.highestMessageIdByChat)) return false;
  if (value.activeViewByChat !== undefined && (!object(value.activeViewByChat) || !Object.values(value.activeViewByChat).every(item => object(item) && typeof item.messageId === "number" && typeof item.revision === "number" && typeof item.view === "string"))) return false;
  if (value.lastCreatedTicketByChat !== undefined && (!object(value.lastCreatedTicketByChat) || !Object.values(value.lastCreatedTicketByChat).every(item => object(item) && typeof item.jobId === "string" && typeof item.projectId === "string"))) return false;
  if (value.botMessageIdsByChat !== undefined && (!object(value.botMessageIdsByChat) || !Object.values(value.botMessageIdsByChat).every(item => Array.isArray(item) && item.every(id => typeof id === "number")))) return false;
  return true;
}

/** Local long-polling adapter. It never starts unless a Telegram token is configured. */
/** Performs this backend operation. */
export class TelegramBot {
  private readonly stateFile: string;
  private readonly lockFile: string;
  private lockToken?: string;
  private state: TelegramState;
  private polling = false;
  private timer?: NodeJS.Timeout;
  private commandsConfiguredFor?: string;
  private started = false;

  constructor(private readonly dependencies: TelegramBotDependencies, dataDirectory = ".jev") {
    mkdirSync(dataDirectory, { recursive: true });
    this.stateFile = join(dataDirectory, "telegram-bot.json");
    this.lockFile = join(dataDirectory, "telegram-bot.lock");
    const saved = readDurableJson<Partial<TelegramState> & { botMessageIdsByChat?: Record<string, number[]> }>(this.stateFile, validTelegramState, () => ({}));
    const legacyHighest = Object.fromEntries(Object.entries(saved.botMessageIdsByChat ?? {}).map(([chatId, ids]) => [chatId, Math.max(0, ...ids)]));
    this.state = {
      offset: saved.offset ?? 0,
      awaitingTicketProjectByChat: saved.awaitingTicketProjectByChat ?? {},
      activeViewByChat: saved.activeViewByChat ?? {},
      lastCreatedTicketByChat: saved.lastCreatedTicketByChat ?? {},
      highestMessageIdByChat: { ...legacyHighest, ...(saved.highestMessageIdByChat ?? {}) }
    };
  }

  start() { if (this.started || !this.acquireLock()) return; this.started = true; void this.bootstrap(); }
  stop() { this.started = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.releaseLock(); }
  refresh() { void this.configureCommands(); this.schedule(0); }

  /** Allows one Telegram polling loop per local JEV data directory. */
  private acquireLock() {
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const descriptor = openSync(this.lockFile, "wx", 0o600);
        try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); }
        finally { closeSync(descriptor); }
        this.lockToken = token;
        process.once("exit", () => this.releaseLock());
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner: { pid?: number; token?: string };
        try { owner = JSON.parse(readFileSync(this.lockFile, "utf8")); }
        catch { return false; }
        if (!Number.isInteger(owner.pid) || !owner.pid) return false;
        try { process.kill(owner.pid, 0); return false; }
        catch (checkError) { if ((checkError as NodeJS.ErrnoException).code !== "ESRCH") return false; }
        try {
          const current = JSON.parse(readFileSync(this.lockFile, "utf8")) as { token?: string };
          if (current.token !== owner.token) return false;
          unlinkSync(this.lockFile);
        } catch { return false; }
      }
    }
    return false;
  }

  /** Releases only the lock owned by this bot instance. */
  private releaseLock() {
    if (!this.lockToken) return;
    try {
      const owner = JSON.parse(readFileSync(this.lockFile, "utf8")) as { token?: string };
      if (owner.token === this.lockToken) unlinkSync(this.lockFile);
    } catch { /* Another process may already have replaced the lock. */ }
    this.lockToken = undefined;
  }

  /** Sends a best-effort notice when a Codex development run finishes. */
  async notifyDevelopmentFinished(project: ProjectRecord, jobs: Job[]) {
    const config = this.dependencies.config();
    if (!config.telegramBotToken || !config.telegramEnabled || !config.telegramAllowedChatId || !jobs.length) return;
    const success = jobs.filter(job => job.status === "SUCCESS").length;
    const failed = jobs.filter(job => job.status === "FAILED").length;
    const statusLines = jobs.map(job => {
      const context = job.execution?.codexStatus?.context;
      const contextLeft = context && context.windowTokens > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - context.usedTokens / context.windowTokens)))) : undefined;
      const fiveHourLeft = job.execution?.codexStatus?.fiveHour?.remainingPercent;
      return `${job.status === "SUCCESS" ? "✅" : "❌"} Task ${this.escape(job.id.slice(0, 8))}: context ${contextLeft === undefined ? "unavailable" : `${contextLeft}% left`} · 5h limit ${fiveHourLeft === undefined ? "unavailable" : `${fiveHourLeft}% left`}`;
    });
    const text = `🏁 <b>Development finished · ${this.escape(project.name)}</b>\n${success} completed · ${failed} failed${jobs.length - success - failed ? ` · ${jobs.length - success - failed} skipped` : ""}\n\n${statusLines.join("\n")}`;
    const sent = await this.request<TelegramMessage>(config.telegramBotToken, "sendMessage", { chat_id: config.telegramAllowedChatId, text, parse_mode: "HTML" });
    if (!sent) throw new Error("Telegram did not confirm the completion notice");
    this.rememberMessage(config.telegramAllowedChatId, sent?.message_id);
    if (sent) this.persist();
  }

  private configured(config = this.dependencies.config()) { return Boolean(config.telegramBotToken); }
  private async configureCommands() {
    const config = this.dependencies.config();
    if (!this.configured(config) || this.commandsConfiguredFor === config.telegramBotToken) return;
    const applied = await this.request<boolean>(config.telegramBotToken, "setMyCommands", { commands: [{ command: "start", description: "Open JEV Codex Pilot" }] });
    if (applied) this.commandsConfiguredFor = config.telegramBotToken;
  }
  private async bootstrap() {
    await this.configureCommands();
    this.schedule(0);
  }
  private schedule(delay: number) {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delay);
  }
  private persist() { writeDurableJson(this.stateFile, this.state); }
  private endpoint(token: string, method: string) { return `https://api.telegram.org/bot${token}/${method}`; }
  private async request<T>(token: string, method: string, payload: Record<string, unknown>): Promise<T | undefined> {
    try {
      const response = await fetch(this.endpoint(token, method), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return undefined;
      const result = await response.json() as { ok?: boolean; result?: T };
      return result.ok ? result.result : undefined;
    } catch { return undefined; }
  }
  private async getUpdates(config: AppConfig, timeout: number) {
    const result = await this.request<TelegramUpdate[]>(config.telegramBotToken, "getUpdates", { offset: this.state.offset, timeout, allowed_updates: ["message", "callback_query"] });
    return Array.isArray(result) ? result : [];
  }
  private rememberMessage(chatId: string, messageId?: number) {
    if (!messageId) return;
    this.state.highestMessageIdByChat[chatId] = Math.max(this.state.highestMessageIdByChat[chatId] ?? 0, messageId);
  }
  private callbackData(revision: number, action: TelegramAction, argument?: string) { return `${revision}|${action}|${argument ?? ""}`; }
  private markup(screen: TelegramScreen, revision: number): TelegramReplyMarkup {
    return { inline_keyboard: screen.buttons.map(row => row.map(button => ({ text: button.text, callback_data: this.callbackData(revision, button.action, button.argument) }))) };
  }
  private async send(token: string, chatId: string, screen: TelegramScreen, revision: number) {
    const result = await this.request<TelegramMessage>(token, "sendMessage", { chat_id: chatId, text: screen.text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: this.markup(screen, revision) });
    if (result?.message_id) this.rememberMessage(chatId, result.message_id);
    return result;
  }
  private async render(token: string, chatId: string, screen: TelegramScreen) {
    const current = this.state.activeViewByChat[chatId];
    const revision = (current?.revision ?? 0) + 1;
    let result: TelegramMessage | undefined;
    if (current?.messageId) {
      result = await this.request<TelegramMessage>(token, "editMessageText", { chat_id: chatId, message_id: current.messageId, text: screen.text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: this.markup(screen, revision) });
    }
    result ??= await this.send(token, chatId, screen, revision);
    if (result?.message_id) this.state.activeViewByChat[chatId] = { messageId: result.message_id, revision, view: screen.view };
  }
  private async answerCallback(token: string, callbackId: string, text?: string) {
    await this.request(token, "answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text, show_alert: false } : {}) });
  }
  private async deleteMessageIds(token: string, chatId: string, messageIds: number[]) {
    const unique = [...new Set(messageIds.filter(id => Number.isInteger(id) && id > 0))].sort((a, b) => b - a);
    for (let index = 0; index < unique.length; index += 100) {
      const batch = unique.slice(index, index + 100);
      const deleted = await this.request<boolean>(token, "deleteMessages", { chat_id: chatId, message_ids: batch });
      if (!deleted) {
        for (const messageId of batch) await this.request(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
      }
    }
  }
  private async resetChat(token: string, chatId: string, throughMessageId = this.state.highestMessageIdByChat[chatId] ?? 0) {
    const allMessageIds = Array.from({ length: throughMessageId }, (_, index) => throughMessageId - index);
    await this.deleteMessageIds(token, chatId, allMessageIds);
    delete this.state.awaitingTicketProjectByChat[chatId];
    delete this.state.activeViewByChat[chatId];
    delete this.state.lastCreatedTicketByChat[chatId];
  }
  private async deleteIncoming(token: string, chatId: string, messageId: number) {
    await this.deleteMessageIds(token, chatId, [messageId]);
  }

  private async poll() {
    if (this.polling) return;
    const config = this.dependencies.config();
    if (!this.configured(config)) { this.schedule(2_000); return; }
    void this.configureCommands();
    this.polling = true;
    try {
      const updates = await this.getUpdates(config, 25);
      for (const update of updates) {
        this.state.offset = Math.max(this.state.offset, update.update_id + 1);
        await this.handleUpdate(config, update);
      }
      this.persist();
    } finally {
      this.polling = false;
      this.schedule(900);
    }
  }

  private authorized(chat: TelegramChat | undefined, config: AppConfig) { return config.telegramEnabled && String(chat?.id ?? "") === config.telegramAllowedChatId; }
  private projects() { return this.dependencies.listProjects(); }
  private projectById(id: string | undefined) { return this.projects().find(project => project.id === id); }
  private pendingJobs(project: ProjectRecord) { return this.dependencies.listJobs(project.id).filter(job => !job.archivedAt && job.status === "PENDING"); }
  private home(notice?: string) { return homeScreen(this.projects(), projectId => this.dependencies.listJobs(projectId), notice); }
  private parseCallback(data?: string) {
    const [rawRevision, action, argument] = (data ?? "").split("|", 3);
    return { revision: Number(rawRevision), action: action as TelegramAction, argument: argument || undefined };
  }
  private validCallback(chatId: string, messageId: number | undefined, revision: number, action: TelegramAction) {
    const active = this.state.activeViewByChat[chatId];
    return Boolean(active && active.messageId === messageId && active.revision === revision && allowedActions[active.view].includes(action));
  }

  private async handleCallback(config: AppConfig, chatId: string, callback: TelegramCallback) {
    const parsed = this.parseCallback(callback.data);
    if (!this.validCallback(chatId, callback.message?.message_id, parsed.revision, parsed.action)) {
      await this.answerCallback(config.telegramBotToken, callback.id, "This screen is no longer active.");
      return;
    }
    await this.answerCallback(config.telegramBotToken, callback.id);
    const project = this.projectById(parsed.argument);
    if (parsed.action === "home") {
      delete this.state.awaitingTicketProjectByChat[chatId];
      await this.render(config.telegramBotToken, chatId, this.home());
    } else if (parsed.action === "projects") {
      await this.render(config.telegramBotToken, chatId, projectsScreen(this.projects()));
    } else if (parsed.action === "new") {
      await this.render(config.telegramBotToken, chatId, newTicketProjectScreen(this.projects()));
    } else if (parsed.action === "run-menu") {
      await this.render(config.telegramBotToken, chatId, runProjectScreen(this.projects(), projectId => this.dependencies.listJobs(projectId).filter(job => !job.archivedAt && job.status === "PENDING")));
    } else if (parsed.action === "clear") {
      await this.resetChat(config.telegramBotToken, chatId);
      await this.render(config.telegramBotToken, chatId, this.home("🧹 <b>Chat reset complete.</b>"));
    } else if (parsed.action === "cancel") {
      delete this.state.awaitingTicketProjectByChat[chatId];
      await this.render(config.telegramBotToken, chatId, this.home("↩️ <b>Ticket creation cancelled.</b>"));
    } else if (parsed.action === "project") {
      if (!project) return void await this.render(config.telegramBotToken, chatId, noticeScreen("⚠️ <b>PROJECT UNAVAILABLE</b>", "This project no longer exists."));
      await this.render(config.telegramBotToken, chatId, projectScreen(project, this.dependencies.listJobs(project.id)));
    } else if (parsed.action === "ticket") {
      if (!project) return void await this.render(config.telegramBotToken, chatId, noticeScreen("⚠️ <b>PROJECT UNAVAILABLE</b>", "This project no longer exists."));
      this.state.awaitingTicketProjectByChat[chatId] = project.id;
      await this.render(config.telegramBotToken, chatId, composeTicketScreen(project));
    } else if (parsed.action === "run") {
      if (!project || this.pendingJobs(project).length === 0) return void await this.render(config.telegramBotToken, chatId, this.home("ℹ️ <b>Nothing to launch.</b>"));
      const result = this.dependencies.runPending?.(project) ?? "empty";
      const notice = result === "started"
        ? `▶️ <b>Codex is starting for ${this.escape(project.name)}.</b>`
        : result === "running"
          ? `⚡ <b>Codex is already running for ${this.escape(project.name)}.</b>`
          : `ℹ️ <b>No pending ticket remains in ${this.escape(project.name)}.</b>`;
      await this.render(config.telegramBotToken, chatId, this.home(notice));
    } else if (parsed.action === "delete-request") {
      const created = this.state.lastCreatedTicketByChat[chatId];
      const createdProject = this.projectById(created?.projectId);
      const job = createdProject ? this.dependencies.listJobs(createdProject.id).find(candidate => candidate.id === parsed.argument && candidate.id === created?.jobId && candidate.status === "PENDING") : undefined;
      if (!createdProject || !job) return void await this.render(config.telegramBotToken, chatId, this.home("ℹ️ <b>This ticket can no longer be deleted here.</b>"));
      await this.render(config.telegramBotToken, chatId, deleteConfirmationScreen(createdProject, job));
    } else if (parsed.action === "delete-cancel") {
      const created = this.state.lastCreatedTicketByChat[chatId];
      const createdProject = this.projectById(created?.projectId);
      const job = createdProject ? this.dependencies.listJobs(createdProject.id).find(candidate => candidate.id === created?.jobId) : undefined;
      if (createdProject && job) await this.render(config.telegramBotToken, chatId, createdTicketScreen(createdProject, job));
      else await this.render(config.telegramBotToken, chatId, this.home());
    } else if (parsed.action === "delete-confirm") {
      const created = this.state.lastCreatedTicketByChat[chatId];
      if (!created || created.jobId !== parsed.argument) return void await this.render(config.telegramBotToken, chatId, this.home("ℹ️ <b>This ticket can no longer be deleted here.</b>"));
      const removed = this.dependencies.removeTicket?.(created.jobId);
      delete this.state.lastCreatedTicketByChat[chatId];
      await this.render(config.telegramBotToken, chatId, this.home(removed ? "🗑 <b>Ticket deleted.</b>" : "ℹ️ <b>The ticket was already unavailable.</b>"));
    }
  }

  private escape(value: string) { return value.replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!); }
  private async handleMessage(config: AppConfig, chatId: string, message: TelegramMessage) {
    const text = message.text?.trim();
    if (/^\/start(?:@\w+)?$/i.test(text ?? "")) {
      await this.resetChat(config.telegramBotToken, chatId, message.message_id);
      await this.render(config.telegramBotToken, chatId, this.home());
      return;
    }
    const project = this.projectById(this.state.awaitingTicketProjectByChat[chatId]);
    await this.deleteIncoming(config.telegramBotToken, chatId, message.message_id);
    if (!project) {
      if (!this.state.activeViewByChat[chatId]) await this.render(config.telegramBotToken, chatId, this.home("ℹ️ <i>Use the buttons below to navigate.</i>"));
      return;
    }
    if (!text || text.startsWith("/")) {
      await this.render(config.telegramBotToken, chatId, composeTicketScreen(project, "Please send a plain-text description, or use Cancel."));
      return;
    }
    if (text.length > 12_000) {
      await this.render(config.telegramBotToken, chatId, composeTicketScreen(project, "The description must stay below 12,000 characters."));
      return;
    }
    try {
      const job = this.dependencies.createTicket(project, text);
      delete this.state.awaitingTicketProjectByChat[chatId];
      this.state.lastCreatedTicketByChat[chatId] = { jobId: job.id, projectId: project.id };
      await this.render(config.telegramBotToken, chatId, createdTicketScreen(project, job));
    } catch {
      delete this.state.awaitingTicketProjectByChat[chatId];
      await this.render(config.telegramBotToken, chatId, this.home("⚠️ <b>Ticket creation failed.</b> Check that the project still has an AGENTS.md file."));
    }
  }

  private async handleUpdate(config: AppConfig, update: TelegramUpdate) {
    const chat = update.message?.chat ?? update.callback_query?.message?.chat;
    if (!chat) return;
    const chatId = String(chat.id);
    this.rememberMessage(chatId, update.message?.message_id ?? update.callback_query?.message?.message_id);
    if (!this.authorized(chat, config)) {
      const text = update.message?.text?.trim() ?? "";
      if (!config.telegramAllowedChatId && /^\/start(?:@\w+)?$/i.test(text)) {
        this.dependencies.pairChat?.(chatId);
        await this.resetChat(config.telegramBotToken, chatId, update.message?.message_id);
        await this.render(config.telegramBotToken, chatId, this.home("🔐 <b>Private chat paired · Bot enabled.</b>"));
      }
      return;
    }
    if (update.callback_query) await this.handleCallback(config, chatId, update.callback_query);
    else if (update.message) await this.handleMessage(config, chatId, update.message);
  }
}
