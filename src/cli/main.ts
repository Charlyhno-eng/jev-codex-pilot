import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { AppConfigStore } from "../core/app-config.js";
import { codexModelId } from "../core/codex-models.js";
import { JobQueue } from "../core/queue.js";
import { Orchestrator } from "../core/orchestrator.js";
import { ProjectStore } from "../core/projects.js";
import { acquireApiInstance } from "../core/single-instance.js";
import type { Job, ProjectRecord } from "../core/types.js";

const cliCommand = `node "${realpathSync(process.argv[1] ?? "bin/jc-pilot.mjs")}"`;
const help = `Usage: ${cliCommand} run "describe one task"
       ${cliCommand} status [ticket-id]

Run from the project directory. The command analyses the task with JEV, runs
Codex with the selected model and bounded context, and waits for validation.
The project needs AGENTS.md; on an interactive terminal, JEV can create it
from a short description you provide. Existing JEV settings and history are
shared with the web application.

For the short command jc-pilot, run npm run setup:cli once in the JEV repository,
then open a new terminal. No global npm link or administrator rights are needed.`;

function say(message: string) { process.stdout.write(`${message}\n`); }
function fail(message: string): never { throw new Error(message); }
function done(job: Job): boolean { return ["SUCCESS", "FAILED", "SESSION_PAUSED", "SKIPPED"].includes(job.status); }

function summary(job: Job) {
  say(`\nTicket ${job.id} · ${job.status}`);
  if (job.analysis) say(`Route: ${job.execution?.model ?? codexModelId(job.analysis.model)} / ${job.execution?.reasoning ?? job.analysis.reasoning} · complexity ${job.analysis.complexity}/5`);
  if (job.execution) say(`Verification: ${job.execution.verification}`);
  if (job.error) say(`Error: ${job.error}`);
  if (job.status === "SESSION_PAUSED") say(`Codex session paused${job.sessionResumeAt ? ` until ${job.sessionResumeAt}` : ""}. The ticket remains in JEV history.`);
}

async function projectContext(projectDirectory: string): Promise<string | undefined> {
  if (existsSync(join(projectDirectory, "AGENTS.md"))) return undefined;
  if (!process.stdin.isTTY) fail("This project needs AGENTS.md. Create it in the project directory before running non-interactively.");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const context = (await input.question("Briefly describe this project for AGENTS.md: ")).trim();
    if (!context) fail("A project description is required to create AGENTS.md.");
    return context;
  } finally { input.close(); }
}

function apiBase(): string {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("PORT must be a valid local API port.");
  return `http://127.0.0.1:${port}/api`;
}

async function request<T>(base: string, path: string, method = "GET", payload?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, { method, headers: payload === undefined ? undefined : { "Content-Type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) fail(data.error || `JEV API returned HTTP ${response.status}`);
  return data;
}

async function useApi(): Promise<string> {
  const base = apiBase();
  try {
    const health = await request<{ ok: boolean; app?: string }>(base, "/health");
    if (!health.ok || health.app !== "jev-codex-pilot") throw new Error("Unexpected local API");
  }
  catch { fail(`JEV is already using its history, but the local API at ${base} is unavailable. Set PORT to the running API port or stop that process.`); }
  return base;
}

async function runViaApi(base: string, projectDirectory: string, description: string, context?: string) {
  const settings = await request<{ configured: boolean }>(base, "/settings");
  if (!settings.configured) fail("Configure a Vercel AI Gateway key in JEV Settings before starting a ticket.");
  const project = await request<ProjectRecord>(base, "/projects", "POST", { path: projectDirectory, context });
  const jobs = await request<Job[]>(base, `/jobs?projectId=${encodeURIComponent(project.id)}`);
  if (jobs.some(job => job.status === "RUNNING")) fail("A Codex execution is already running for this project.");
  const [created] = await request<Job[]>(base, "/jobs", "POST", { projectId: project.id, tasks: [{ description }] });
  say(`Ticket ${created.id} created in ${projectDirectory}`);
  const prepared = await request<Job>(base, `/jobs/${created.id}/prepare`, "POST");
  if (prepared.analysis) say(`JEV: complexity ${prepared.analysis.complexity}/5 · ${codexModelId(prepared.analysis.model)}/${prepared.analysis.reasoning} · ${prepared.analysis.context_files.length} context files`);
  await request<Job>(base, `/jobs/${created.id}/run`, "POST");
  say("Codex started. Waiting for JEV validation…");
  let lastPhase = "";
  while (true) {
    const job = await request<Job>(base, `/jobs/${created.id}`);
    const phase = `${job.status}:${job.execution?.phase ?? ""}`;
    if (phase !== lastPhase && job.status === "RUNNING") say(`Codex: ${job.execution?.phase.toLowerCase() ?? "working"}`);
    lastPhase = phase;
    if (done(job)) { summary(job); process.exitCode = job.status === "SUCCESS" ? 0 : 1; return; }
    await new Promise(resolve => setTimeout(resolve, 900));
  }
}

async function runLocally(dataDirectory: string, projectDirectory: string, description: string, context?: string) {
  if (!new AppConfigStore().read().aiGatewayApiKey) fail("Configure a Vercel AI Gateway key in JEV Settings before starting a ticket.");
  const projects = new ProjectStore(dataDirectory);
  const queue = new JobQueue(dataDirectory);
  queue.recoverInterrupted(pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } });
  const project = projects.create(projectDirectory, undefined, context);
  if (queue.list(project.id).some(job => job.status === "RUNNING")) fail("A Codex execution is already running for this project.");
  projects.touch(project.id);
  const job = queue.create(project.id, project.path, [{ description }]);
  say(`Ticket ${job.id} created in ${projectDirectory}`);
  const orchestrator = new Orchestrator(queue);
  const prepared = await orchestrator.prepare(job);
  if (prepared?.analysis) say(`JEV: ${prepared.analysis.context_files.length} context files selected`);
  const result = await orchestrator.run(job.id);
  summary(result);
  process.exitCode = result.status === "SUCCESS" ? 0 : 1;
}

async function statusViaApi(base: string, projectDirectory: string, ticketId?: string) {
  const projects = await request<ProjectRecord[]>(base, "/projects");
  const project = projects.find(item => item.path === projectDirectory);
  if (!project) fail("This directory has no JEV project history yet.");
  const jobs = await request<Job[]>(base, `/jobs?projectId=${encodeURIComponent(project.id)}`);
  const job = ticketId ? jobs.find(item => item.id === ticketId) : jobs[0];
  if (!job) fail("No matching ticket in this project.");
  summary(job);
}

function statusLocally(dataDirectory: string, projectDirectory: string, ticketId?: string) {
  const project = new ProjectStore(dataDirectory).list().find(item => item.path === projectDirectory);
  if (!project) fail("This directory has no JEV project history yet.");
  const jobs = new JobQueue(dataDirectory).list(project.id);
  const job = ticketId ? jobs.find(item => item.id === ticketId) : jobs[0];
  if (!job) fail("No matching ticket in this project.");
  summary(job);
}

export async function main(args: string[], projectDirectory: string) {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") { say(help); return; }
  if (command !== "run" && command !== "status") { process.stderr.write(`Unknown command: ${command}\n\n${help}\n`); process.exitCode = 2; return; }
  if (command === "run" && (rest.length !== 1 || !rest[0].trim())) { process.stderr.write(`${help}\n`); process.exitCode = 2; return; }
  if (command === "status" && rest.length > 1) { process.stderr.write(`${help}\n`); process.exitCode = 2; return; }
  try {
    const directory = resolve(projectDirectory);
    if (command === "run" && !new AppConfigStore().read().aiGatewayApiKey) fail("Configure a Vercel AI Gateway key in JEV Settings before starting a ticket.");
    const context = command === "run" ? await projectContext(directory) : undefined;
    const dataDirectory = resolve(process.cwd(), ".jev");
    let release: (() => void) | undefined;
    try { release = await acquireApiInstance(dataDirectory); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Another JEV API process")) throw error;
      const base = await useApi();
      if (command === "run") await runViaApi(base, directory, rest[0].trim(), context);
      else await statusViaApi(base, directory, rest[0]);
      return;
    }
    try {
      if (command === "run") await runLocally(dataDirectory, directory, rest[0].trim(), context);
      else statusLocally(dataDirectory, directory, rest[0]);
    } finally { release(); }
  } catch (error) {
    process.stderr.write(`jc-pilot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
