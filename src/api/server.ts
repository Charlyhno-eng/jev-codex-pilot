import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { JobQueue } from "../core/queue.js";
import { Orchestrator } from "../core/orchestrator.js";
import { ProjectStore } from "../core/projects.js";
import { fetchGatewayCredits } from "../core/gateway-credits.js";
import { AppConfigStore, maskedApiKey } from "../core/app-config.js";
import { listProjectFiles } from "../core/project-reader.js";
import { readProjectDiff } from "../core/git-diff.js";
import { AttachmentStore, type ImageAttachmentInput } from "../core/attachments.js";
import { selectDirectory } from "../core/native-dialog.js";
import type { TaskSpec } from "../core/types.js";

const queue = new JobQueue(resolve(process.cwd(), ".jev"));
const projects = new ProjectStore(resolve(process.cwd(), ".jev"));
const orchestrator = new Orchestrator(queue);
const appConfig = new AppConfigStore();
const attachments = new AttachmentStore(resolve(process.cwd(), ".jev"));
const sessionJevJobIds = new Set<string>();
const port = Number(process.env.PORT ?? 3000);

function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  response.end(JSON.stringify(data));
}
async function body(request: IncomingMessage): Promise<unknown> {
  let raw = ""; for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 28 * 1024 * 1024) throw new Error("The request is too large. Attach at most four images of 5 MB each."); }
  return raw ? JSON.parse(raw) : {};
}

createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") return json(response, 204, {});
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true });
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      const projectId = url.searchParams.get("projectId") ?? undefined;
      return json(response, 200, queue.list(projectId).filter(job => Boolean(projects.get(job.projectId))));
    }
    if (request.method === "GET" && url.pathname === "/api/usage") {
      const jobs = [...sessionJevJobIds].map(id => queue.get(id)).filter((job): job is NonNullable<typeof job> => Boolean(job));
      const inputTokens = jobs.reduce((total, job) => total + (job.analysis?.evaluation_usage?.input_tokens ?? 0), 0);
      const estimatedCostUsd = jobs.reduce((total, job) => total + (job.analysis?.evaluation_usage?.estimated_cost_usd ?? 0), 0);
      return json(response, 200, { analyses: jobs.length, inputTokens, estimatedCostUsd });
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
      return json(response, 200, { configured: Boolean(settings.aiGatewayApiKey), maskedApiKey: maskedApiKey(settings.aiGatewayApiKey) });
    }
    if (request.method === "GET" && url.pathname === "/api/settings/api-key") {
      const settings = appConfig.read();
      if (!settings.aiGatewayApiKey) return json(response, 404, { error: "No Vercel AI Gateway API key has been configured." });
      return json(response, 200, { apiKey: settings.aiGatewayApiKey });
    }
    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const input = await body(request) as { apiKey?: unknown };
      if (typeof input.apiKey !== "string" || !input.apiKey.trim()) return json(response, 400, { error: "A Vercel AI Gateway API key is required." });
      const settings = appConfig.write({ aiGatewayApiKey: input.apiKey.trim() });
      return json(response, 200, { configured: true, maskedApiKey: maskedApiKey(settings.aiGatewayApiKey) });
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
      return json(response, 200, { path: absolute, files, count: files.length, truncated: files.length >= 5000, hasAgents: existsSync(resolve(absolute, "AGENTS.md")) });
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
      const withAttachments = created.map((job, index) => queue.update(job.id, { attachments: attachments.saveForJob(job.id, taskInputs[index].attachments) })!);
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
    const match = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(prepare|command|run|run-batch|skip|archive|unarchive|move|adjust|edit))?$/);
    if (!match) return json(response, 404, { error: "Route not found" });
    const [, id, action] = match; const job = queue.get(id);
    if (!job) return json(response, 404, { error: "Job not found" });
    if (request.method === "GET" && !action) return json(response, 200, job);
    if (request.method === "POST" && action === "prepare") { const prepared = await orchestrator.prepare(job); sessionJevJobIds.add(id); return json(response, 200, prepared); }
    if (request.method === "POST" && action === "command") return json(response, 200, { command: await orchestrator.command(job) });
    if (request.method === "POST" && action === "skip") return json(response, 200, queue.transition(id, "SKIPPED"));
    if (request.method === "POST" && action === "archive") return json(response, 200, queue.archive(id));
    if (request.method === "POST" && action === "unarchive") return json(response, 200, queue.unarchive(id));
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
      return json(response, 200, queue.adjustAnalysis(id, input.dimension, input.delta));
    }
    if (request.method === "POST" && action === "run") {
      if (job.status === "RUNNING" || orchestrator.isBatchRunning(id)) return json(response, 409, { error: "This task sequence is already running." });
      void orchestrator.run(id).catch(error => { const current = queue.get(id); if (current && current.status !== "SUCCESS") queue.transition(id, "FAILED", { error: error instanceof Error ? error.message : "Codex failed to start" }); });
      return json(response, 202, queue.get(id));
    }
    if (request.method === "POST" && action === "run-batch") {
      if (orchestrator.isBatchRunning(id)) return json(response, 409, { error: "This task sequence is already running." });
      void orchestrator.runBatch(id).catch(error => { const current = queue.get(id); if (current && current.status !== "SUCCESS") queue.transition(id, "FAILED", { error: error instanceof Error ? error.message : "Task sequence failed to start" }); });
      return json(response, 202, queue.get(id));
    }
    return json(response, 405, { error: "Method not allowed" });
  } catch (error) { return json(response, 500, { error: error instanceof Error ? error.message : "Internal server error" }); }
}).listen(port, "127.0.0.1", () => console.log(`JEV API ready at http://localhost:${port}`));
