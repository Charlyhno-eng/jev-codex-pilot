import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { JobQueue } from "../core/queue.js";
import { Orchestrator } from "../core/orchestrator.js";
import { ProjectLanguages } from "../core/project-languages.js";
import { ProjectStore } from "../core/projects.js";
import { fetchVercelGatewayCredits, VERCEL_AI_GATEWAY_DASHBOARD_URL } from "../core/vercel-ai-gateway.js";
import { AppConfigStore, maskedApiKey } from "../core/app-config.js";
import { listProjectFiles } from "../core/project-reader.js";
import { readProjectDiff } from "../core/git-diff.js";
import { pushGitBranch, readGitWorkspace, selectGitBranch } from "../core/git-workspace.js";
import { ensureProjectLinterTicket, ProjectLinterStatus } from "../core/project-linter.js";
import { SkillStore, SkillValidationError } from "../core/skills.js";
import { AttachmentStore, type ImageAttachmentInput } from "../core/attachments.js";
import { selectDirectory } from "../core/native-dialog.js";
import type { TaskSpec } from "../core/types.js";
import { COMPLEXITY_ROUTES, MODEL_LEVELS, REASONING_LEVELS } from "../core/codex-models.js";
import { availableCodexModels, selectCodexModelId } from "../core/codex-catalog.js";
import { logJev, logJevApplied, logJevError, logSession } from "../core/jev-logger.js";
import { acquireApiInstance } from "../core/single-instance.js";
import { listIdeFiles, readIdeFile } from "../core/ide-files.js";
import { ProjectTerminals } from "../core/project-terminal.js";

await acquireApiInstance(resolve(process.cwd(), ".jev"));
const queue = new JobQueue(resolve(process.cwd(), ".jev"));
const projectLanguages = new ProjectLanguages();
const projectLinterStatus = new ProjectLinterStatus();
const withLanguages = (project: ReturnType<ProjectStore["create"]>) => {
  const completed = queue.listProjectExecutionOrder(project.id).filter(job => job.status === "SUCCESS");
  return { ...project, languages: projectLanguages.get(project.path), linterConfigured: projectLinterStatus.get(project.path, completed.filter(job => job.kind === "linter_setup").flatMap(job => job.linterLanguages ?? []), completed.map(job => job.id).join(",")) };
};
const projects = new ProjectStore(resolve(process.cwd(), ".jev"));
const orchestrator = new Orchestrator(queue);
orchestrator.configureGitDelivery(projectId => Boolean(projects.get(projectId)?.autoCommitPush));
orchestrator.configureHumanReview(projectId => Boolean(projects.get(projectId)?.humanInTheLoop));
const appConfig = new AppConfigStore();
const attachments = new AttachmentStore(resolve(process.cwd(), ".jev"));
const skills = new SkillStore(resolve(process.cwd(), ".jev"));
const sessionJevJobIds = new Set<string>();
const requestedProjectQueues = new Set<string>();
const port = Number(process.env.PORT ?? 3000);
const terminals = new ProjectTerminals();
process.once("exit", () => { queue.flush(); terminals.dispose(); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { terminals.dispose(); process.exit(0); });

/** Requires same-origin browser requests before granting local file or shell access. */
function trustedWorkspaceRequest(request: IncomingMessage, requireOrigin = true) {
  const host = request.headers.host?.split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1") return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const source = request.headers.origin ?? request.headers.referer;
  if (!source) return !requireOrigin && !request.headers["sec-fetch-site"];
  try {
    const origin = new URL(source);
    return origin.protocol === "http:" && (origin.hostname === "localhost" || origin.hostname === "127.0.0.1") && (origin.host === request.headers.host || origin.port === String(port) || origin.port === "5173");
  } catch { return false; }
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

/** Starts explicitly requested work when the project slot becomes available. */
function startRequestedQueue(projectId: string) {
  if (!requestedProjectQueues.has(projectId) || orchestrator.isProjectRunning(projectId)) return;
  requestedProjectQueues.delete(projectId);
  if (orchestrator.needsHumanReview(projectId)) return;
  const next = queue.listProjectExecutionOrder(projectId).find(job => job.status === "PENDING" || job.status === "SESSION_PAUSED");
  if (next?.status === "PENDING") void runTicket(next.id, true);
}

/** Runs a ticket or sequence and records any startup failure. */
async function runTicket(jobId: string, batch: boolean) {
  const starting = queue.get(jobId);
  if (!starting) return;
  try {
    if (batch) await orchestrator.runBatch(jobId);
    else await orchestrator.run(jobId);
  } catch (error) {
    const current = queue.get(jobId);
    if (current && (current.status === "PENDING" || current.status === "RUNNING" || current.status === "ESCALATING") && !orchestrator.ownsProjectRun(current.projectId)) queue.transition(jobId, "FAILED", { error: error instanceof Error ? error.message : "Codex failed to start", errorCategory: current.execution ? "codex" : "jev" });
  } finally { startRequestedQueue(starting.projectId); }
}

/** Checks whether a previously recorded Codex process is still alive. */
function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    try { if (/\)\s+Z\s/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))) return false; } catch { /* procfs is optional. */ }
    return true;
  }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Stops an orphan only when its PID still belongs to Codex and its heartbeat expired. */
function stopStaleCodexProcesses() {
  for (const job of queue.list().filter(item => (item.status === "RUNNING" || item.status === "ESCALATING") && !orchestrator.ownsProjectRun(item.projectId))) {
    const pid = job.execution?.pid;
    const heartbeat = job.execution?.heartbeatAt ?? job.execution?.lastActivityAt;
    if (!pid || !heartbeat || Date.now() - Date.parse(heartbeat) < 30 * 60_000 || !processAlive(pid)) continue;
    let command: string;
    try { command = readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
    if (!command.split("\0").some(argument => /(?:^|\/)codex$/.test(argument))) continue;
    try {
      process.kill(pid, "SIGTERM");
      logJevError(`Stopped abandoned Codex process ${pid} for task ${job.id.slice(0, 8)} after 30 minutes without a server heartbeat`);
    } catch { /* A process that exited here will be recovered on the next check. */ }
  }
}

/** Recovers abandoned executions without launching Codex without a new user action. */
function recoverInterruptedWork() {
  stopStaleCodexProcesses();
  for (const job of queue.recoverInterrupted(processAlive, id => orchestrator.ownsProjectRun(id))) {
    logJev(`Task ${job.id.slice(0, 8)} recovered after server interruption; review before relaunching`);
  }
}

/** Restarts eligible tickets after Codex reports that its session limit has reset. */
async function resumeSessionPausedWork() {
  if (resumingSessionPausedWork) return;
  resumingSessionPausedWork = true;
  try {
    const resumed = await orchestrator.resumeSessionPausedJobs();
    for (const job of resumed) {
      logSession(`Codex session reset; automatically resuming task ${job.id.slice(0, 8)}`);
      void runTicket(job.id, true);
    }
  } finally { resumingSessionPausedWork = false; }
}
let resumingSessionPausedWork = false;

/** Sends a JSON API response. */
function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}
/** Reads a JSON API request body. */
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 28 * 1024 * 1024) throw new RequestValidationError("The request is too large. Attach at most four images of 5 MB each.");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try { parsed = bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
  catch { throw new RequestValidationError("Provide a valid JSON request body."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RequestValidationError("Provide a JSON object.");
  return parsed;
}

/** Distinguishes invalid client requests from server failures. */
class RequestValidationError extends Error {}

/** Routes requests for the local JEV API. */
createServer(async (request, response) => {
  try {
    if (!trustedWorkspaceRequest(request, false)) return json(response, 403, { error: "Open this API from the local JEV application." });
    if (request.method === "OPTIONS") return json(response, 204, {});
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/api/skills" && request.method === "GET") return json(response, 200, skills.list());
    if (url.pathname === "/api/skills" && request.method === "POST") {
      if (!trustedWorkspaceRequest(request)) return json(response, 403, { error: "Skill imports require a local browser origin." });
      const input = await body(request) as { files?: unknown };
      const imported = skills.import(input.files);
      return json(response, 201, skills.list().find(skill => skill.id === imported.id));
    }
    const skillMatch = url.pathname.match(/^\/api\/skills\/([a-zA-Z0-9-]+)$/);
    if (skillMatch && request.method === "GET") {
      const skill = skills.preview(skillMatch[1]);
      return json(response, skill ? 200 : 404, skill ?? { error: "Skill not found." });
    }
    if (skillMatch && request.method === "DELETE") {
      if (!trustedWorkspaceRequest(request)) return json(response, 403, { error: "Skill changes require a local browser origin." });
      skills.remove(skillMatch[1]);
      return json(response, 200, { removed: true });
    }
    if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true, app: "jev-codex-pilot" });
    if (request.method === "GET" && url.pathname === "/api/codex-models") {
      const available = await availableCodexModels();
      return json(response, 200, { models: Object.fromEntries(MODEL_LEVELS.map(tier => [tier, selectCodexModelId(tier, available)])), modelLevels: MODEL_LEVELS, reasoningLevels: REASONING_LEVELS, complexityRoutes: COMPLEXITY_ROUTES });
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      const projectId = url.searchParams.get("projectId") ?? undefined;
      const jobs = (projectId ? queue.listProjectExecutionOrder(projectId) : queue.list()).filter(job => Boolean(projects.get(job.projectId)));
      if (url.searchParams.get("view") === "status") return json(response, 200, jobs.map(({ id, projectId, status }) => ({ id, projectId, status })));
      if (url.searchParams.get("view") !== "summary") return json(response, 200, jobs);
      const projectActivity = new Map([...new Set(jobs.map(job => job.projectId))].map(id => [id, orchestrator.isProjectRunning(id)]));
      const detailId = url.searchParams.get("detailId");
      const history = detailId ? jobs.filter(job => job.execution || job.error).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
      const selectedId = history.find(job => job.id === detailId)?.id ?? (history.find(job => job.status === "RUNNING" || job.status === "ESCALATING") ?? history[0])?.id;
      return json(response, 200, jobs.map(job => {
        if (job.id === selectedId) return { ...job, projectBusy: projectActivity.get(job.projectId) };
        const summary = { ...job };
        delete summary.output;
        const skills = job.skills?.map(skill => Object.fromEntries(Object.entries(skill).filter(([key]) => key !== "content" && key !== "path")));
        return { ...summary, projectBusy: projectActivity.get(job.projectId), skills, execution: job.execution ? { ...job.execution, events: [] } : undefined };
      }));
    }
    if (request.method === "GET" && url.pathname === "/api/usage") {
      const jobs = [...sessionJevJobIds].map(id => queue.get(id)).filter((job): job is NonNullable<typeof job> => Boolean(job));
      const inputTokens = jobs.reduce((total, job) => total + (job.analysis?.evaluation_usage?.input_tokens ?? 0), 0);
      const estimatedCostUsd = jobs.reduce((total, job) => total + (job.analysis?.evaluation_usage?.estimated_cost_usd ?? 0), 0);
      return json(response, 200, {
        analyses: jobs.length,
        inputTokens,
        estimatedCostUsd
      });
    }
    if (request.method === "GET" && url.pathname === "/api/projects") return json(response, 200, projects.list().map(withLanguages));
    if (request.method === "POST" && url.pathname === "/api/projects") {
      const input = await body(request) as { path?: string; name?: string; context?: string };
      if (!input.path) return json(response, 400, { error: "A project directory is required" });
      const project = projects.create(input.path, input.name, input.context);
      if (!orchestrator.isProjectRunning(project.id)) ensureProjectLinterTicket(queue, project.id, project.path);
      return json(response, 201, withLanguages(project));
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (request.method === "GET" && projectMatch) {
      const project = projects.get(projectMatch[1]);
      if (project && !orchestrator.isProjectRunning(project.id)) ensureProjectLinterTicket(queue, project.id, project.path, false);
      return project ? json(response, 200, withLanguages(project)) : json(response, 404, { error: "Project not found" });
    }
    if (request.method === "PUT" && projectMatch) {
      const project = projects.get(projectMatch[1]);
      if (!project) return json(response, 404, { error: "Project not found" });
      const input = await body(request) as { humanInTheLoop?: unknown };
      if (typeof input.humanInTheLoop !== "boolean") return json(response, 400, { error: "humanInTheLoop must be true or false." });
      if (typeof input.humanInTheLoop === "boolean") {
        if (!input.humanInTheLoop && !orchestrator.isProjectRunning(project.id)) orchestrator.approveHumanReview(project.id);
        projects.setHumanInTheLoop(project.id, input.humanInTheLoop);
      }
      return json(response, 200, withLanguages(projects.get(project.id)!));
    }
    if (request.method === "DELETE" && projectMatch) {
      const project = projects.get(projectMatch[1]);
      if (!project) return json(response, 404, { error: "Project not found" });
      if (orchestrator.isProjectRunning(project.id)) return json(response, 409, { error: "Wait for the active Codex execution to finish before removing this project." });
      terminals.dispose(project.id);
      return json(response, 200, projects.unregister(project.id));
    }
    const ideMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/(files|terminal)(?:\/([^/]+))?$/);
    if (ideMatch) {
      if (!trustedWorkspaceRequest(request)) return json(response, 403, { error: "Open this workspace from the local JEV application." });
      const project = projects.get(ideMatch[1]);
      if (!project) return json(response, 404, { error: "Project not found" });
      const [, , resource, sessionId] = ideMatch;
      try {
        if (resource === "files" && request.method === "GET" && !sessionId) {
          const path = url.searchParams.get("path");
          return json(response, 200, path === null ? { files: listIdeFiles(project.path) } : readIdeFile(project.path, path));
        }
        if (resource === "terminal") {
          if (request.method === "GET") return json(response, 200, sessionId ? terminals.read(project.id, sessionId, Number(url.searchParams.get("cursor") ?? 0)) : terminals.list(project.id));
          if (request.method === "POST" && !sessionId) return json(response, 201, terminals.start(project.id, project.path));
          if (request.method === "POST" && sessionId) { terminals.write(project.id, sessionId, await body(request) as { data?: unknown; cols?: unknown; rows?: unknown }); return json(response, 200, { ok: true }); }
          if (request.method === "DELETE" && sessionId) { terminals.close(project.id, sessionId); return json(response, 200, { closed: true }); }
        }
        return json(response, 405, { error: "Method not allowed" });
      } catch { return json(response, 400, { error: resource === "files" ? "File unavailable: select a text file up to 1 MB within this project. Private files are hidden." : "Terminal operation failed. Check the session, input size, dimensions, and the four-terminal limit." }); }
    }
    const diffMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/diff$/);
    if (request.method === "GET" && diffMatch) {
      const project = projects.get(diffMatch[1]);
      return project ? json(response, 200, readProjectDiff(project.path, url.searchParams.get("commit") ?? undefined)) : json(response, 404, { error: "Project not found" });
    }
    const gitMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/git(?:\/(branch|settings|push))?$/);
    if (gitMatch) {
      const project = projects.get(gitMatch[1]);
      if (!project) return json(response, 404, { error: "Project not found" });
      if (request.method === "GET" && !gitMatch[2]) return json(response, 200, { ...readGitWorkspace(project.path), busy: orchestrator.isProjectRunning(project.id) });
      if (request.method === "POST" && gitMatch[2] === "branch") {
        if (orchestrator.isProjectRunning(project.id)) return json(response, 409, { error: "Wait for the active ticket to finish before changing branches." });
        const input = await body(request) as { name?: unknown; create?: unknown };
        if (orchestrator.isProjectRunning(project.id)) return json(response, 409, { error: "Wait for the active execution to finish before changing branches." });
        if (typeof input.name !== "string" || typeof input.create !== "boolean") return json(response, 400, { error: "A branch name and create choice are required." });
        return json(response, 200, selectGitBranch(project.path, input.name, input.create));
      }
      if (request.method === "POST" && gitMatch[2] === "push") {
        if (orchestrator.isProjectRunning(project.id)) return json(response, 409, { error: orchestrator.isProjectGitActionRunning(project.id) ? "A Git action is already running for this project. Wait for it to finish." : "Wait for the active ticket to finish before pushing." });
        try { return json(response, 200, await orchestrator.withProjectGitAction(project.id, async () => pushGitBranch(project.path))); }
        finally { startRequestedQueue(project.id); }
      }
      if (request.method === "PUT" && gitMatch[2] === "settings") {
        if (orchestrator.isProjectRunning(project.id)) return json(response, 409, { error: "Wait for the active ticket to finish before changing Git automation." });
        const input = await body(request) as { autoCommitPush?: unknown };
        if (orchestrator.isProjectRunning(project.id)) return json(response, 409, { error: "Wait for the active execution to finish before changing Git automation." });
        if (typeof input.autoCommitPush !== "boolean") return json(response, 400, { error: "autoCommitPush must be true or false." });
        return json(response, 200, projects.setAutoCommitPush(project.id, input.autoCommitPush));
      }
    }
    if (request.method === "GET" && url.pathname === "/api/billing") {
      const apiKey = appConfig.read().aiGatewayApiKey;
      if (!apiKey) return json(response, 503, { error: "Configure a Vercel AI Gateway API key in Settings to retrieve the credit balance." });
      const balance = await fetchVercelGatewayCredits(apiKey);
      return json(response, 200, {
        balance,
        source: "gateway",
        dashboardUrl: VERCEL_AI_GATEWAY_DASHBOARD_URL
      });
    }
    if (request.method === "GET" && url.pathname === "/api/settings") {
      const settings = appConfig.read();
      return json(response, 200, {
        configured: Boolean(settings.aiGatewayApiKey),
        maskedApiKey: maskedApiKey(settings.aiGatewayApiKey)
      });
    }
    if (request.method === "GET" && url.pathname === "/api/settings/secrets") {
      if (!trustedWorkspaceRequest(request)) return json(response, 403, { error: "Private settings require a local browser origin." });
      const settings = appConfig.read();
      return json(response, 200, { apiKey: settings.aiGatewayApiKey });
    }
    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const input = await body(request) as { apiKey?: unknown };
      const change: Parameters<AppConfigStore["write"]>[0] = {};
      if (input.apiKey !== undefined) {
        if (typeof input.apiKey !== "string" || !input.apiKey.trim()) return json(response, 400, { error: "A Vercel AI Gateway API key is required." });
        change.aiGatewayApiKey = input.apiKey.trim();
      }
      if (!Object.keys(change).length) return json(response, 400, { error: "Provide at least one setting to update." });
      const settings = appConfig.write(change);
      return json(response, 200, {
        configured: Boolean(settings.aiGatewayApiKey),
        maskedApiKey: maskedApiKey(settings.aiGatewayApiKey)
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
      const input = await body(request) as { projectId?: string; run?: boolean; tasks?: Array<TaskSpec & { attachments?: ImageAttachmentInput[]; skillIds?: unknown }> };
      if (!input || typeof input !== "object" || !Array.isArray(input.tasks) || input.tasks.some(task => !task || typeof task.description !== "string")) return json(response, 400, { error: "Provide a list of task descriptions." });
      const taskInputs = input.tasks.filter(task => task.description.trim());
      for (const task of taskInputs) attachments.validate(task.attachments);
      const selections = taskInputs.map(task => skills.select(task.skillIds));
      const tasks = taskInputs.map(task => ({ description: task.description.trim() }));
      const project = input.projectId ? projects.get(input.projectId) : undefined;
      if (!project || !tasks.length) return json(response, 400, { error: "A saved project and at least one task are required" });
      if (!projects.hasAgents(project.id)) return json(response, 400, { error: "Describe the application and create AGENTS.md before analyzing tasks." });
      projects.touch(project.id);
      const created = queue.createBatch(project.id, project.path, tasks);
      const withAttachments = created.map((job, index) => queue.update(job.id, { attachments: attachments.saveForJob(job.id, taskInputs[index].attachments), skills: skills.freeze(job.id, selections[index]) })!);
      // Creation with run=true explicitly requests execution, including an idle queue.
      if (input.run === true) { requestedProjectQueues.add(project.id); startRequestedQueue(project.id); }
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
    const attachmentMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/attachments\/([^/]+)$/);
    if (request.method === "GET" && attachmentMatch) {
      const job = queue.get(attachmentMatch[1]);
      const attachment = job?.attachments?.find(candidate => candidate.id === attachmentMatch[2]);
      if (!attachment || !existsSync(attachment.path)) return json(response, 404, { error: "Image attachment not found" });
      response.writeHead(200, { "Content-Type": attachment.mimeType, "Cache-Control": "no-store" });
      return response.end(readFileSync(attachment.path));
    }
    const match = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(prepare|command|run|run-batch|continue|skip|archive|unarchive|remove|move|reorder|adjust|edit))?$/);
    if (!match) return json(response, 404, { error: "Route not found" });
    const [, id, action] = match; const job = queue.get(id);
    if (!job) return json(response, 404, { error: "Job not found" });
    if (!projects.get(job.projectId)) return json(response, 404, { error: "Project not found" });
    if (request.method === "GET" && !action) return json(response, 200, job);
    if (request.method === "POST" && action === "prepare") {
      const input = await body(request) as { reevaluate?: unknown };
      if (input?.reevaluate === true) {
        if (job.status !== "PENDING" || orchestrator.isProjectRunning(job.projectId)) return json(response, 409, { error: "Wait for an idle pending ticket before re-evaluating." });
        queue.update(id, { analysis: undefined });
      }
      await orchestrator.prepare(queue.get(id)!); sessionJevJobIds.add(id); return json(response, 200, queue.get(id));
    }
    if (request.method === "POST" && action === "command") return json(response, 200, { command: await orchestrator.command(job) });
    if (request.method === "POST" && action === "skip") {
      if (job.status !== "PENDING" || orchestrator.ownsTicketRun(id)) return json(response, 409, { error: "Only idle pending tickets can be skipped." });
      return json(response, 200, queue.transition(id, "SKIPPED"));
    }
    if (request.method === "POST" && action === "archive") return json(response, 200, queue.archive(id));
    if (request.method === "POST" && action === "unarchive") return json(response, 200, queue.unarchive(id));
    if (request.method === "POST" && action === "remove") {
      if (orchestrator.ownsTicketRun(id)) return json(response, 409, { error: "Wait for this ticket to finish before removing it." });
      const removed = queue.removePending(id);
      if (removed) { attachments.removeForJob(removed.id); skills.removeForJob(removed.id); }
      return json(response, 200, { id: removed?.id, removed: true });
    }
    if (request.method === "POST" && action === "reorder") {
      const input = await body(request) as { beforeId?: unknown };
      if (input.beforeId !== null && typeof input.beforeId !== "string") return json(response, 400, { error: "Choose a pending destination ticket or null for the end of the queue." });
      return json(response, 200, queue.reorderPending(id, input.beforeId));
    }
    if (request.method === "POST" && action === "move") {
      const input = await body(request) as { status?: unknown };
      if (input.status !== "PENDING" && input.status !== "SUCCESS") return json(response, 400, { error: "Choose Pending or Success as the destination." });
      return json(response, 200, queue.moveManually(id, input.status));
    }
    if (request.method === "POST" && action === "edit") {
      const input = await body(request) as { description?: unknown; attachments?: ImageAttachmentInput[]; skillIds?: unknown };
      if (orchestrator.ownsTicketRun(id)) return json(response, 409, { error: "Wait for this ticket to finish before editing it." });
      if (typeof input.description !== "string" || !input.description.trim()) return json(response, 400, { error: "A task description is required." });
      const editable = queue.get(id)!;
      attachments.validate(input.attachments);
      if ((editable.attachments?.length ?? 0) + (input.attachments?.length ?? 0) > 4) return json(response, 400, { error: "Attach at most four images to one task." });
      if (editable.status !== "PENDING" || editable.archivedAt) return json(response, 400, { error: "Only pending tickets can be edited." });
      const selectedSkills = input.skillIds === undefined ? undefined : skills.updateSelection(id, input.skillIds, editable.skills);
      const updated = queue.updatePendingTask(id, input.description)!;
      if (selectedSkills) queue.update(id, { skills: selectedSkills });
      const nextAttachments = input.attachments === undefined ? updated.attachments : [...(updated.attachments ?? []), ...attachments.saveForJob(updated.id, input.attachments)];
      if (nextAttachments !== updated.attachments) queue.update(updated.id, { attachments: nextAttachments });
      const prepared = await orchestrator.prepare(queue.get(updated.id)!);
      sessionJevJobIds.add(id);
      return json(response, 200, prepared);
    }
    if (request.method === "POST" && action === "adjust") {
      const input = await body(request) as { dimension?: unknown; delta?: unknown };
      if (orchestrator.ownsTicketRun(id)) return json(response, 409, { error: "Wait for this ticket to finish before adjusting it." });
      if (input.dimension !== "model" && input.dimension !== "reasoning") return json(response, 400, { error: "Choose model or reasoning to adjust." });
      if (input.delta !== -1 && input.delta !== 1) return json(response, 400, { error: "The adjustment must be exactly one level down or up." });
      const adjusted = queue.adjustAnalysis(id, input.dimension, input.delta);
      const before = String(job.analysis?.[input.dimension] ?? "unknown");
      const after = String(adjusted?.analysis?.[input.dimension] ?? "unknown");
      if (before === after) logJev(`No further ${input.dimension} adjustment is available · task ${id.slice(0, 8)}`);
      else logJevApplied(`${before.toUpperCase()} → ${after.toUpperCase()}`, `task ${id.slice(0, 8)}`);
      return json(response, 200, adjusted);
    }
    if (request.method === "POST" && action === "continue") {
      if (!orchestrator.needsHumanReview(job.projectId) || orchestrator.isProjectRunning(job.projectId)) return json(response, 409, { error: "This project is not waiting for human review." });
      const next = queue.listProjectExecutionOrder(job.projectId).find(item => item.status === "PENDING" || item.status === "SESSION_PAUSED");
      if (next?.status === "SESSION_PAUSED") return json(response, 409, { error: "Wait for the Codex session to become available." });
      orchestrator.approveHumanReview(job.projectId);
      if (next) void runTicket(next.id, true);
      return json(response, 202, { continued: Boolean(next) });
    }
    if (request.method === "POST" && (action === "run" || action === "run-batch") && orchestrator.needsHumanReview(job.projectId)) return json(response, 409, { error: "Approve the previous ticket with Continue before running more work." });
    if (request.method === "POST" && action === "run") {
      if (job.status !== "PENDING" || orchestrator.isProjectRunning(job.projectId)) return json(response, 409, { error: "This task cannot start while another execution is active or it is not pending." });
      void runTicket(id, false);
      return json(response, 202, queue.get(id));
    }
    if (request.method === "POST" && action === "run-batch") {
      if (job.status !== "PENDING" || orchestrator.isProjectRunning(job.projectId)) return json(response, 409, { error: "This task sequence cannot start while another execution is active or it is not pending." });
      void runTicket(id, true);
      return json(response, 202, queue.get(id));
    }
    return json(response, 405, { error: "Method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    if (/\bJEV\b|precision|recommendation|analy(?:sis|z)/i.test(message)) logJevError(message);
    return json(response, error instanceof SkillValidationError || error instanceof RequestValidationError ? 400 : 500, { error: message });
  }
}).listen(port, "127.0.0.1", () => {
  recoverInterruptedWork();
  void resumeSessionPausedWork();
  setInterval(recoverInterruptedWork, 60_000);
  setInterval(() => { void resumeSessionPausedWork(); }, 5_000);
  logJev(`API ready at http://localhost:${port}`);
});
