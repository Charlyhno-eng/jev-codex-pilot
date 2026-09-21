import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { JobQueue } from "../core/queue.js";
import { Orchestrator } from "../core/orchestrator.js";
import { ProjectStore } from "../core/projects.js";
import { fetchGatewayCredits } from "../core/gateway-credits.js";
import { AppConfigStore, maskedApiKey } from "../core/app-config.js";
import { listProjectFiles } from "../core/project-reader.js";
import { readProjectDiff } from "../core/git-diff.js";
import { AttachmentStore, type ImageAttachmentInput } from "../core/attachments.js";
import { selectDirectory } from "../core/native-dialog.js";
import type { JevAnalysis, TaskSpec } from "../core/types.js";
import { analyze } from "../core/analyzer.js";
import { estimateJevInputCost } from "../core/jev-pricing.js";
import { TelegramBot } from "../core/telegram-bot.js";
import { MODEL_LEVELS, REASONING_LEVELS } from "../core/codex-models.js";
import { availableCodexModels, selectCodexModelId } from "../core/codex-catalog.js";
import { logJev, logJevError } from "../core/jev-logger.js";

const queue = new JobQueue(resolve(process.cwd(), ".jev"));
const projects = new ProjectStore(resolve(process.cwd(), ".jev"));
const orchestrator = new Orchestrator(queue);
const appConfig = new AppConfigStore();
const attachments = new AttachmentStore(resolve(process.cwd(), ".jev"));
const telegram = new TelegramBot({
  config: () => appConfig.read(),
  listProjects: () => projects.list(),
  listJobs: projectId => queue.list(projectId),
  createTicket: (project, description) => {
    if (!projects.hasAgents(project.id)) throw new Error("AGENTS.md is required");
    projects.touch(project.id);
    const ticket = queue.create(project.id, project.path, [{ description: description.trim() }]);
    logJev(`Task ${ticket.id.slice(0, 8)} created from Telegram and awaiting evaluation`);
    return ticket;
  },
  removeTicket: jobId => queue.removePending(jobId),
  runPending: project => {
    if (queue.list(project.id).some(job => job.status === "RUNNING")) return "running";
    const next = queue.listProjectExecutionOrder(project.id).find(job => !job.archivedAt && job.status === "PENDING");
    if (!next || orchestrator.isBatchRunning(next.id)) return "empty";
    void runWithNotification(next.id, true);
    return "started";
  },
  pairChat: chatId => { appConfig.write({ telegramAllowedChatId: chatId, telegramEnabled: true }); }
}, resolve(process.cwd(), ".jev"));
const sessionJevJobIds = new Set<string>();
const sessionJevPrecisionUsage = { checks: 0, inputTokens: 0, estimatedCostUsd: 0 };
const draftAnalyses = new Map<string, { analysis: JevAnalysis; createdAt: number }>();
const port = Number(process.env.PORT ?? 3000);

/** Consumes a recent full JEV analysis for a draft task. */
function consumeDraftAnalysis(projectId: string, description: string) {
  const now = Date.now();
  for (const [key, value] of draftAnalyses) if (now - value.createdAt > 10 * 60_000) draftAnalyses.delete(key);
  const key = `${projectId}:${description.trim()}`;
  const analysis = draftAnalyses.get(key)?.analysis;
  if (analysis) draftAnalyses.delete(key);
  return analysis;
}

/** Checks whether the folder belongs to a Git worktree. */
function isGitRepository(path: string) {
  try { return execFileSync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() === "true"; }
  catch { return false; }
}

/** Checks whether a local Git repository has a GitHub remote. */
function hasGithubRemote(path: string) {
  try {
    const remotes = execFileSync("git", ["-C", path, "remote", "-v"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return remotes.split("\n").some(line => /(?:^|[/:@])github\.com[/:]/i.test(line));
  } catch { return false; }
}

/** Runs Codex and reports the final project result to the configured private chat. */
async function runWithNotification(jobId: string, batch: boolean) {
  const starting = queue.get(jobId);
  if (!starting) return;
  const before = new Map(queue.list(starting.projectId).map(job => [job.id, job.attempts]));
  try {
    if (batch) await orchestrator.runBatch(jobId);
    else await orchestrator.run(jobId);
  } catch (error) {
    const current = queue.get(jobId);
    if (current && current.status !== "SUCCESS") queue.transition(jobId, "FAILED", { error: error instanceof Error ? error.message : "Codex failed to start" });
  } finally {
    const project = projects.get(starting.projectId);
    const finished = queue.list(starting.projectId).filter(job => job.attempts > (before.get(job.id) ?? 0) && (job.status === "SUCCESS" || job.status === "FAILED"));
    if (project && finished.length) void telegram.notifyDevelopmentFinished(project, finished).catch(() => {
      logJevError("Telegram completion notice could not be saved");
    });
  }
}

/** Sends a JSON API response. */
function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  response.end(JSON.stringify(data));
}
/** Reads a JSON API request body. */
async function body(request: IncomingMessage): Promise<unknown> {
  let raw = ""; for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 28 * 1024 * 1024) throw new Error("The request is too large. Attach at most four images of 5 MB each."); }
  return raw ? JSON.parse(raw) : {};
}

/** Routes requests for the local JEV API. */
createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") return json(response, 204, {});
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true });
    if (request.method === "GET" && url.pathname === "/api/codex-models") {
      const available = await availableCodexModels();
      return json(response, 200, { models: Object.fromEntries(MODEL_LEVELS.map(tier => [tier, selectCodexModelId(tier, available)])), modelLevels: MODEL_LEVELS, reasoningLevels: REASONING_LEVELS });
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      const projectId = url.searchParams.get("projectId") ?? undefined;
      return json(response, 200, queue.list(projectId).filter(job => Boolean(projects.get(job.projectId))));
    }
    if (request.method === "GET" && url.pathname === "/api/usage") {
      const jobs = [...sessionJevJobIds].map(id => queue.get(id)).filter((job): job is NonNullable<typeof job> => Boolean(job));
      const inputTokens = jobs.reduce((total, job) => total + (job.analysis?.evaluation_usage?.input_tokens ?? 0), 0);
      const estimatedCostUsd = jobs.reduce((total, job) => total + (job.analysis?.evaluation_usage?.estimated_cost_usd ?? 0), 0);
      return json(response, 200, {
        analyses: jobs.length,
        precisionChecks: sessionJevPrecisionUsage.checks,
        inputTokens: inputTokens + sessionJevPrecisionUsage.inputTokens,
        estimatedCostUsd: estimatedCostUsd + sessionJevPrecisionUsage.estimatedCostUsd
      });
    }
    if (request.method === "GET" && url.pathname === "/api/projects") return json(response, 200, projects.list());
    if (request.method === "POST" && url.pathname === "/api/projects") {
      const input = await body(request) as { path?: string; name?: string; context?: string };
      if (!input.path) return json(response, 400, { error: "A project directory is required" });
      return json(response, 201, projects.create(input.path, input.name, input.context));
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (request.method === "GET" && projectMatch) {
      const project = projects.get(projectMatch[1]);
      return project ? json(response, 200, project) : json(response, 404, { error: "Project not found" });
    }
    if (request.method === "DELETE" && projectMatch) {
      const project = projects.get(projectMatch[1]);
      if (!project) return json(response, 404, { error: "Project not found" });
      if (queue.list(project.id).some(job => job.status === "RUNNING")) return json(response, 409, { error: "Wait for the active Codex execution to finish before removing this project." });
      return json(response, 200, projects.unregister(project.id));
    }
    const diffMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/diff$/);
    if (request.method === "GET" && diffMatch) {
      const project = projects.get(diffMatch[1]);
      return project ? json(response, 200, readProjectDiff(project.path)) : json(response, 404, { error: "Project not found" });
    }
    if (request.method === "GET" && url.pathname === "/api/billing") {
      const apiKey = appConfig.read().aiGatewayApiKey;
      if (!apiKey) return json(response, 503, { error: "Configure a Vercel AI Gateway API key in Settings to retrieve the credit balance." });
      const balance = await fetchGatewayCredits(apiKey);
      return json(response, 200, {
        balance,
        source: "gateway",
        dashboardUrl: "https://vercel.com/ai-gateway"
      });
    }
    if (request.method === "GET" && url.pathname === "/api/settings") {
      const settings = appConfig.read();
      return json(response, 200, {
        configured: Boolean(settings.aiGatewayApiKey),
        maskedApiKey: maskedApiKey(settings.aiGatewayApiKey),
        telegram: {
          configured: Boolean(settings.telegramBotToken),
          maskedBotToken: maskedApiKey(settings.telegramBotToken),
          enabled: settings.telegramEnabled && Boolean(settings.telegramBotToken && settings.telegramAllowedChatId),
          allowedChatId: settings.telegramAllowedChatId
        }
      });
    }
    if (request.method === "GET" && url.pathname === "/api/settings/secrets") {
      const settings = appConfig.read();
      return json(response, 200, { apiKey: settings.aiGatewayApiKey, telegramBotToken: settings.telegramBotToken });
    }
    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const input = await body(request) as { apiKey?: unknown; telegramBotToken?: unknown; telegramAllowedChatId?: unknown; telegramEnabled?: unknown };
      const change: Parameters<AppConfigStore["write"]>[0] = {};
      if (input.apiKey !== undefined) {
        if (typeof input.apiKey !== "string" || !input.apiKey.trim()) return json(response, 400, { error: "A Vercel AI Gateway API key is required." });
        change.aiGatewayApiKey = input.apiKey.trim();
      }
      if (input.telegramBotToken !== undefined) {
        if (typeof input.telegramBotToken !== "string" || !input.telegramBotToken.trim()) return json(response, 400, { error: "A Telegram bot token is required when replacing it." });
        change.telegramBotToken = input.telegramBotToken.trim();
      }
      if (input.telegramAllowedChatId !== undefined) {
        if (typeof input.telegramAllowedChatId !== "string" || !/^-?\d+$/.test(input.telegramAllowedChatId.trim())) return json(response, 400, { error: "The authorized Telegram chat ID must be numeric." });
        change.telegramAllowedChatId = input.telegramAllowedChatId.trim();
      }
      if (input.telegramEnabled !== undefined) {
        if (typeof input.telegramEnabled !== "boolean") return json(response, 400, { error: "Telegram enabled must be true or false." });
        change.telegramEnabled = input.telegramEnabled;
      }
      if (!Object.keys(change).length) return json(response, 400, { error: "Provide at least one setting to update." });
      const settings = appConfig.write(change);
      telegram.refresh();
      return json(response, 200, {
        configured: Boolean(settings.aiGatewayApiKey),
        maskedApiKey: maskedApiKey(settings.aiGatewayApiKey),
        telegram: { configured: Boolean(settings.telegramBotToken), maskedBotToken: maskedApiKey(settings.telegramBotToken), enabled: settings.telegramEnabled && Boolean(settings.telegramBotToken && settings.telegramAllowedChatId), allowedChatId: settings.telegramAllowedChatId }
      });
    }
    if (request.method === "POST" && url.pathname === "/api/system/select-directory") {
      return json(response, 200, { path: await selectDirectory() });
    }
    if (request.method === "GET" && url.pathname === "/api/project") {
      const projectPath = url.searchParams.get("path");
      if (!projectPath) return json(response, 400, { error: "A project path is required" });
      const absolute = resolve(projectPath);
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return json(response, 400, { error: "The selected project directory does not exist" });
      const files = listProjectFiles(absolute);
      const hasGit = isGitRepository(absolute);
      return json(response, 200, { path: absolute, files, count: files.length, truncated: files.length >= 5000, hasAgents: existsSync(resolve(absolute, "AGENTS.md")), isGitRepository: hasGit, isGithubLinked: hasGit && hasGithubRemote(absolute) });
    }
    if (request.method === "POST" && url.pathname === "/api/jobs") {
      const input = await body(request) as { projectId?: string; tasks?: Array<TaskSpec & { attachments?: ImageAttachmentInput[] }> };
      const taskInputs = Array.isArray(input.tasks) ? input.tasks.filter(task => task?.description?.trim()) : [];
      for (const task of taskInputs) attachments.validate(task.attachments);
      const tasks = taskInputs.map(task => ({ description: task.description.trim() }));
      const project = input.projectId ? projects.get(input.projectId) : undefined;
      if (!project || !tasks.length) return json(response, 400, { error: "A saved project and at least one task are required" });
      if (!projects.hasAgents(project.id)) return json(response, 400, { error: "Describe the application and create AGENTS.md before analyzing tasks." });
      projects.touch(project.id);
      const created = queue.createBatch(project.id, project.path, tasks);
      for (const job of created) logJev(`Task ${job.id.slice(0, 8)} created and awaiting evaluation`);
      const withAttachments = created.map((job, index) => {
        const draftAnalysis = consumeDraftAnalysis(project.id, tasks[index].description);
        if (draftAnalysis) {
          const inputTokens = draftAnalysis.evaluation_usage?.input_tokens ?? draftAnalysis.evaluation_usage?.total_tokens ?? 0;
          sessionJevPrecisionUsage.inputTokens = Math.max(0, sessionJevPrecisionUsage.inputTokens - inputTokens);
          sessionJevPrecisionUsage.estimatedCostUsd = Math.max(0, sessionJevPrecisionUsage.estimatedCostUsd - estimateJevInputCost(inputTokens));
        }
        return queue.update(job.id, { analysis: draftAnalysis, attachments: attachments.saveForJob(job.id, taskInputs[index].attachments) })!;
      });
      return json(response, 201, withAttachments);
    }
    const agentsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/agents$/);
    if (request.method === "GET" && agentsMatch) return json(response, 200, { content: projects.readAgents(agentsMatch[1]) });
    if (request.method === "POST" && agentsMatch) {
      const input = await body(request) as { context?: string };
      return json(response, 200, projects.initializeAgents(agentsMatch[1], input.context ?? ""));
    }
    if (request.method === "PUT" && agentsMatch) {
      const input = await body(request) as { content?: string };
      return json(response, 200, { content: projects.updateAgents(agentsMatch[1], input.content ?? "") });
    }
    const taskPrecisionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/task-precision$/);
    if (request.method === "POST" && taskPrecisionMatch) {
      const project = projects.get(taskPrecisionMatch[1]);
      if (!project) return json(response, 404, { error: "Project not found" });
      if (!projects.hasAgents(project.id)) return json(response, 400, { error: "AGENTS.md is required before JEV can assess task precision." });
      const input = await body(request) as { description?: unknown };
      if (typeof input.description !== "string" || !input.description.trim()) return json(response, 400, { error: "A task description is required." });
      const analysis = await analyze(project.path, [{ description: input.description.trim() }]);
      draftAnalyses.set(`${project.id}:${input.description.trim()}`, { analysis, createdAt: Date.now() });
      const inputTokens = analysis.evaluation_usage?.input_tokens ?? analysis.evaluation_usage?.total_tokens ?? 0;
      sessionJevPrecisionUsage.checks += 1;
      sessionJevPrecisionUsage.inputTokens += inputTokens;
      sessionJevPrecisionUsage.estimatedCostUsd += estimateJevInputCost(inputTokens);
      return json(response, 200, { precision: analysis.precision_score });
    }
    const threadControlMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/thread\/(compact|clear)$/);
    if (threadControlMatch) {
      const [, projectId, action] = threadControlMatch;
      if (!projects.get(projectId)) return json(response, 404, { error: "Project not found" });
      if (request.method === "GET") return json(response, 200, orchestrator.projectThreadStatus(projectId));
      if (request.method !== "POST") return json(response, 405, { error: "Method not allowed" });
      if (queue.list(projectId).some(job => job.status === "RUNNING")) return json(response, 409, { error: "Wait for the active Codex execution to finish before changing this project thread." });
      return json(response, 200, action === "compact" ? await orchestrator.compactProjectThread(projectId) : await orchestrator.clearProjectThread(projectId));
    }
    const attachmentMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/attachments\/([^/]+)$/);
    if (request.method === "GET" && attachmentMatch) {
      const job = queue.get(attachmentMatch[1]);
      const attachment = job?.attachments?.find(candidate => candidate.id === attachmentMatch[2]);
      if (!attachment || !existsSync(attachment.path)) return json(response, 404, { error: "Image attachment not found" });
      response.writeHead(200, { "Content-Type": attachment.mimeType, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      return response.end(readFileSync(attachment.path));
    }
    const match = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(prepare|command|run|run-batch|skip|archive|unarchive|remove|move|adjust|edit))?$/);
    if (!match) return json(response, 404, { error: "Route not found" });
    const [, id, action] = match; const job = queue.get(id);
    if (!job) return json(response, 404, { error: "Job not found" });
    if (request.method === "GET" && !action) return json(response, 200, job);
    if (request.method === "POST" && action === "prepare") { const prepared = await orchestrator.prepare(job); sessionJevJobIds.add(id); return json(response, 200, prepared); }
    if (request.method === "POST" && action === "command") return json(response, 200, { command: await orchestrator.command(job) });
    if (request.method === "POST" && action === "skip") return json(response, 200, queue.transition(id, "SKIPPED"));
    if (request.method === "POST" && action === "archive") return json(response, 200, queue.archive(id));
    if (request.method === "POST" && action === "unarchive") return json(response, 200, queue.unarchive(id));
    if (request.method === "POST" && action === "remove") {
      const removed = queue.removePending(id);
      if (removed) attachments.removeForJob(removed.id);
      return json(response, 200, { id: removed?.id, removed: true });
    }
    if (request.method === "POST" && action === "move") {
      const input = await body(request) as { status?: unknown };
      if (input.status !== "PENDING" && input.status !== "SUCCESS") return json(response, 400, { error: "Choose Pending or Success as the destination." });
      return json(response, 200, queue.moveManually(id, input.status));
    }
    if (request.method === "POST" && action === "edit") {
      const input = await body(request) as { description?: unknown; attachments?: ImageAttachmentInput[] };
      if (typeof input.description !== "string") return json(response, 400, { error: "A task description is required." });
      attachments.validate(input.attachments);
      const updated = queue.updatePendingTask(id, input.description)!;
      const nextAttachments = input.attachments === undefined ? updated.attachments : [...(updated.attachments ?? []), ...attachments.saveForJob(updated.id, input.attachments)];
      if (nextAttachments !== updated.attachments) queue.update(updated.id, { attachments: nextAttachments });
      const prepared = await orchestrator.prepare(queue.get(updated.id)!);
      sessionJevJobIds.add(id);
      return json(response, 200, prepared);
    }
    if (request.method === "POST" && action === "adjust") {
      const input = await body(request) as { dimension?: unknown; delta?: unknown };
      if (input.dimension !== "model" && input.dimension !== "reasoning") return json(response, 400, { error: "Choose model or reasoning to adjust." });
      if (input.delta !== -1 && input.delta !== 1) return json(response, 400, { error: "The adjustment must be exactly one level down or up." });
      const adjusted = queue.adjustAnalysis(id, input.dimension, input.delta);
      logJev(`Manual JEV ${input.dimension} adjustment applied to task ${id.slice(0, 8)}`);
      return json(response, 200, adjusted);
    }
    if (request.method === "POST" && action === "run") {
      if (job.status === "RUNNING" || orchestrator.isBatchRunning(id)) return json(response, 409, { error: "This task sequence is already running." });
      void runWithNotification(id, false);
      return json(response, 202, queue.get(id));
    }
    if (request.method === "POST" && action === "run-batch") {
      if (orchestrator.isBatchRunning(id)) return json(response, 409, { error: "This task sequence is already running." });
      void runWithNotification(id, true);
      return json(response, 202, queue.get(id));
    }
    return json(response, 405, { error: "Method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    if (/\bJEV\b|precision|recommendation|analy(?:sis|z)/i.test(message)) logJevError(message);
    return json(response, 500, { error: message });
  }
}).listen(port, "127.0.0.1", () => {
  telegram.start();
  logJev(`API ready at http://localhost:${port}`);
});
