import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { AppConfigStore } from "../core/app-config.js";
import { codexModelId } from "../core/codex-models.js";
import { JobQueue } from "../core/queue.js";
import { Orchestrator } from "../core/orchestrator.js";
import { ProjectStore } from "../core/projects.js";
import { acquireApiInstance } from "../core/single-instance.js";
import { interactiveSession } from "./interactive.js";
import type { Job, ProjectRecord } from "../core/types.js";

const cliCommand = `node "${realpathSync(process.argv[1] ?? "bin/jc-pilot.mjs")}"`;
const help = `Usage: ${cliCommand}                 interactive terminal
       ${cliCommand} run "describe one task"
       ${cliCommand} status [ticket-id]

Run from the project directory. The command analyses the task with JEV, runs
Codex with the selected model, and waits for validation.
The project needs AGENTS.md; on an interactive terminal, JEV can create it
from a short description you provide. Existing JEV settings and history are
shared with the web application.

For the short command jc-pilot, run npm run setup:cli once in the JEV repository,
then open a new terminal. No global npm link or administrator rights are needed.`;

function say(message: string) { process.stdout.write(`${message}\n`); }
function fail(message: string): never { throw new Error(message); }
function persisted(error: unknown): Error {
  return Object.assign(new Error(error instanceof Error ? error.message : String(error)), { ticketsPersisted: true });
}
function done(job: Job): boolean { return ["SUCCESS", "FAILED", "SESSION_PAUSED", "SKIPPED"].includes(job.status); }

function summary(job: Job) {
  say(`\nTicket ${job.id} · ${job.status}`);
  if (job.analysis) say(`Route: ${job.execution?.model ?? codexModelId(job.analysis.model)} / ${job.execution?.reasoning ?? job.analysis.reasoning} · complexity ${job.analysis.complexity}/5`);
  if (job.execution) say(`Verification: ${job.execution.verification}`);
  if (job.error) say(`Error: ${job.error}`);
  if (job.gitDelivery?.status === "committed") say(`Git: committed ${job.gitDelivery.commit} on ${job.gitDelivery.branch}`);
  if (job.gitDelivery?.status === "pushed") say(`Git: pushed ${job.gitDelivery.commit} to ${job.gitDelivery.branch}`);
  if (job.gitDelivery?.status === "failed") say(`Git delivery failed: ${job.gitDelivery.error}`);
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

async function runViaApi(base: string, projectDirectory: string, descriptions: string[], context?: string) {
  const settings = await request<{ configured: boolean }>(base, "/settings");
  if (!settings.configured) fail("Configure a Vercel AI Gateway key in JEV Settings before starting a ticket.");
  const project = await request<ProjectRecord>(base, "/projects", "POST", { path: projectDirectory, context });
  const jobs = await request<Job[]>(base, `/jobs?projectId=${encodeURIComponent(project.id)}`);
  if (jobs.some(job => job.status === "RUNNING" || job.status === "ESCALATING")) fail("A Codex execution is already running for this project.");
  const created = await request<Job[]>(base, "/jobs", "POST", { projectId: project.id, tasks: descriptions.map(description => ({ description })) });
  try {
  for (const [index, job] of created.entries()) say(`Ticket ${index + 1}/${created.length} · ${job.id.slice(0, 8)} · ${descriptions[index]}`);
  for (const job of created) {
    const prepared = await request<Job>(base, `/jobs/${job.id}/prepare`, "POST");
    if (prepared.analysis) say(`JEV ${job.id.slice(0, 8)}: complexity ${prepared.analysis.complexity}/5 · ${codexModelId(prepared.analysis.model)}/${prepared.analysis.reasoning}`);
  }
  await request<Job>(base, `/jobs/${created[0].id}/${created.length > 1 ? "run-batch" : "run"}`, "POST");
  say("Codex started. Waiting for JEV validation…");
  let lastPhase = "";
  while (true) {
    const projectJobs = await request<Job[]>(base, `/jobs?projectId=${encodeURIComponent(project.id)}&view=summary`);
    const jobs = created.map(job => projectJobs.find(item => item.id === job.id) ?? job);
    const setup = projectJobs.find(item => item.kind === "linter_setup" && !item.archivedAt && (["PENDING", "RUNNING", "ESCALATING", "SESSION_PAUSED", "FAILED"].includes(item.status) || item.awaitingHumanReview));
    const observed = setup ? [setup, ...jobs] : jobs;
    const job = observed.find(item => item.status === "RUNNING" || item.status === "ESCALATING") ?? observed.find(item => !done(item)) ?? observed.at(-1)!;
    const phase = `${job.id}:${job.status}:${job.execution?.phase ?? ""}`;
    if (phase !== lastPhase && job.status === "RUNNING") say(`Codex ${job.id.slice(0, 8)}: ${job.execution?.phase.toLowerCase() ?? "working"}`);
    if (phase !== lastPhase && job.status === "ESCALATING") say(`JEV ${job.id.slice(0, 8)} escalation: ${job.analysis?.model ?? "Codex"}/${job.analysis?.reasoning ?? "next route"}`);
    lastPhase = phase;
    if (setup && (done(setup) && setup.status !== "SUCCESS" || setup.awaitingHumanReview) && observed.every(item => item.status !== "RUNNING" && item.status !== "ESCALATING")) {
      summary(setup);
      say("Project linter setup needs attention; implementation tickets remain pending.");
      process.exitCode = 1;
      return;
    }
    if (jobs.every(done) || jobs.some(item => item.status === "SESSION_PAUSED" || item.gitDelivery?.status === "failed") && jobs.every(item => item.status !== "RUNNING" && item.status !== "ESCALATING")) {
      for (const item of jobs) summary(item);
      process.exitCode = jobs.every(item => item.status === "SUCCESS" && item.gitDelivery?.status !== "failed") ? 0 : 1;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 900));
  }
  } catch (error) { throw persisted(error); }
}

async function runLocally(dataDirectory: string, projectDirectory: string, descriptions: string[], context?: string) {
  const config = new AppConfigStore();
  if (!config.read().aiGatewayApiKey) fail("Configure a Vercel AI Gateway key in JEV Settings before starting a ticket.");
  const projects = new ProjectStore(dataDirectory);
  const queue = new JobQueue(dataDirectory);
  queue.recoverInterrupted(pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } });
  const project = projects.create(projectDirectory, undefined, context);
  if (queue.list(project.id).some(job => job.status === "RUNNING" || job.status === "ESCALATING")) fail("A Codex execution is already running for this project.");
  projects.touch(project.id);
  const jobs = descriptions.length === 1 ? [queue.create(project.id, project.path, [{ description: descriptions[0] }])] : queue.createBatch(project.id, project.path, descriptions.map(description => ({ description })));
  try {
  for (const [index, job] of jobs.entries()) say(`Ticket ${index + 1}/${jobs.length} · ${job.id.slice(0, 8)} · ${descriptions[index]}`);
  const orchestrator = new Orchestrator(queue);
  orchestrator.configureGitDelivery(projectId => Boolean(projects.get(projectId)?.autoCommitPush));
  for (const job of jobs) {
    const prepared = await orchestrator.prepare(job);
    if (prepared?.analysis) say(`JEV ${job.id.slice(0, 8)}: complexity ${prepared.analysis.complexity}/5 · ${codexModelId(prepared.analysis.model)}/${prepared.analysis.reasoning}`);
  }
  const singleResult = jobs.length === 1 ? await orchestrator.run(jobs[0].id) : undefined;
  if (jobs.length > 1) await orchestrator.runBatch(jobs[0].id);
  const results = singleResult ? [singleResult] : jobs.map(job => queue.get(job.id) ?? job);
  for (const result of results) summary(result);
  process.exitCode = results.every(result => result.status === "SUCCESS" && result.gitDelivery?.status !== "failed") ? 0 : 1;
  } catch (error) { throw persisted(error); }
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

/** Creates and executes an ordered ticket batch for a selected project. */
export async function executeBatch(directory: string, descriptions: string[], projectDescription?: string) {
  if (!new AppConfigStore().read().aiGatewayApiKey) fail("Configure a Vercel AI Gateway key in JEV Settings before starting a ticket.");
  const context = projectDescription ?? await projectContext(directory);
  const dataDirectory = resolve(process.cwd(), ".jev");
  let release: (() => void) | undefined;
  try { release = await acquireApiInstance(dataDirectory); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Another JEV API process")) throw error;
    await runViaApi(await useApi(), directory, descriptions, context);
    return;
  }
  try { await runLocally(dataDirectory, directory, descriptions, context); }
  finally { release(); }
}

/** Runs the CLI command for the selected project directory. */
export async function main(args: string[], projectDirectory: string) {
  const [command, ...rest] = args;
  if (command === "help" || command === "--help" || command === "-h") { say(help); return; }
  if (command && command !== "run" && command !== "status") { process.stderr.write(`Unknown command: ${command}\n\n${help}\n`); process.exitCode = 2; return; }
  if (command === "run" && (rest.length !== 1 || !rest[0].trim())) { process.stderr.write(`${help}\n`); process.exitCode = 2; return; }
  if (command === "status" && rest.length > 1) { process.stderr.write(`${help}\n`); process.exitCode = 2; return; }
  try {
    const directory = resolve(projectDirectory);
    if (!command) { await interactiveSession(directory, (tasks, context) => executeBatch(directory, tasks, context)); return; }
    if (command === "run") { await executeBatch(directory, [rest[0].trim()]); return; }
    const dataDirectory = resolve(process.cwd(), ".jev");
    let release: (() => void) | undefined;
    try { release = await acquireApiInstance(dataDirectory); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Another JEV API process")) throw error;
      const base = await useApi();
      await statusViaApi(base, directory, rest[0]);
      return;
    }
    try {
      statusLocally(dataDirectory, directory, rest[0]);
    } finally { release(); }
  } catch (error) {
    process.stderr.write(`jc-pilot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
