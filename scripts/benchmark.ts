import { execFileSync, spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, existsSync, copyFileSync, cpSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppConfigStore } from "../src/core/app-config.js";
import { activeCodexModelId } from "../src/core/codex-catalog.js";
import { codexExecPrefix } from "../src/core/codex-execution.js";
import { collectJevUsage, readJevUsageFile, type JevTokenUsage } from "../src/core/jev-usage.js";
import { JobQueue } from "../src/core/queue.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { ProjectStore } from "../src/core/projects.js";
import type { CodexUsage, Job } from "../src/core/types.js";

type Command = string[];
type Price = { inputUsdPerMillion: number; cachedInputUsdPerMillion?: number; outputUsdPerMillion: number };
type Task = { id: string; prompt: string; checks: Command[]; setup?: Command[]; category?: string; timeoutSeconds?: number };
type Scenario = { id: string; revision?: string; setup?: Command[]; tasks: Task[] };
type Suite = { version: 1; repository: string; revision?: string; repetitions?: number; scenarios: Scenario[]; pricing?: { codex?: Record<string, Price>; jev?: Pick<Price, "inputUsdPerMillion" | "outputUsdPerMillion"> } };
type ProcessResult = { code: number | null; timedOut: boolean; stdout: string };
type ModeResult = { status: string; seconds: number; usage?: CodexUsage; codexTokens?: number; cachedInputTokens?: number; estimatedCostUsd?: number; checkExitCodes: Array<number | null>; passed: boolean; threadId?: string; providerUsage?: JevTokenUsage; routes?: Array<{ stage: string; model: string; reasoning: string }> };
type TaskResult = { scenario: string; repetition: number; task: string; category?: string; revision: string; model: string; reasoning: string; baseline?: ModeResult; jev?: ModeResult; error?: string };
type Report = { suite: string; generatedAt: string; source: string; sourceIsGit: boolean; engineRevision: string; engineDirty: boolean; repetitions: number; results: TaskResult[] };

const identifier = /^[a-z0-9][a-z0-9_-]*$/i;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const seconds = () => Number(process.hrtime.bigint()) / 1e9;
const totalTokens = (usage?: CodexUsage) => usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number" ? usage.input_tokens + usage.output_tokens : undefined;
const money = (amount: number) => `$${amount.toFixed(4)}`;

function requireCommand(value: unknown, label: string): asserts value is Command {
  if (!Array.isArray(value) || !value.length || !value.every(part => typeof part === "string" && part.length > 0)) throw new Error(`${label} must be a nonempty argument array`);
}

function validateCommands(value: unknown, label: string): asserts value is Command[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  value.forEach((command, index) => requireCommand(command, `${label}[${index}]`));
}

function validatePrice(value: unknown, label: string): asserts value is Price {
  if (!isObject(value) || !Number.isFinite(value.inputUsdPerMillion) || Number(value.inputUsdPerMillion) < 0 || !Number.isFinite(value.outputUsdPerMillion) || Number(value.outputUsdPerMillion) < 0 || value.cachedInputUsdPerMillion !== undefined && (!Number.isFinite(value.cachedInputUsdPerMillion) || Number(value.cachedInputUsdPerMillion) < 0)) throw new Error(`${label} needs nonnegative input and output prices`);
}

function loadSuite(file: string): Suite {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isObject(value) || value.version !== 1 || typeof value.repository !== "string" || !value.repository.trim() || value.revision !== undefined && (typeof value.revision !== "string" || !value.revision.trim()) || !Array.isArray(value.scenarios) || !value.scenarios.length) throw new Error("Suite needs version 1, repository and scenarios; Git repositories also need a revision");
  if (value.repetitions !== undefined && (!Number.isInteger(value.repetitions) || Number(value.repetitions) < 1 || Number(value.repetitions) > 20)) throw new Error("repetitions must be between 1 and 20");
  const scenarioIds = new Set<string>();
  for (const scenario of value.scenarios) {
    if (!isObject(scenario) || typeof scenario.id !== "string" || !identifier.test(scenario.id) || scenarioIds.has(scenario.id) || !Array.isArray(scenario.tasks) || !scenario.tasks.length) throw new Error("Each scenario needs a unique id and at least one task");
    scenarioIds.add(scenario.id);
    if (scenario.revision !== undefined && (typeof scenario.revision !== "string" || !scenario.revision.trim())) throw new Error(`Invalid revision in ${scenario.id}`);
    if (scenario.setup !== undefined) validateCommands(scenario.setup, `${scenario.id}.setup`);
    const taskIds = new Set<string>();
    for (const task of scenario.tasks) {
      if (!isObject(task) || typeof task.id !== "string" || !identifier.test(task.id) || taskIds.has(task.id) || typeof task.prompt !== "string" || !task.prompt.trim()) throw new Error(`Invalid task in ${scenario.id}`);
      taskIds.add(task.id);
      validateCommands(task.checks, `${scenario.id}.${task.id}.checks`);
      if (!task.checks.length) throw new Error(`${scenario.id}.${task.id} needs at least one independent check`);
      if (task.setup !== undefined) validateCommands(task.setup, `${scenario.id}.${task.id}.setup`);
      if (task.category !== undefined && (typeof task.category !== "string" || !identifier.test(task.category))) throw new Error(`Invalid category in ${scenario.id}.${task.id}`);
      if (task.timeoutSeconds !== undefined && (!Number.isInteger(task.timeoutSeconds) || Number(task.timeoutSeconds) < 60 || Number(task.timeoutSeconds) > 7200)) throw new Error(`timeoutSeconds in ${scenario.id}.${task.id} must be 60–7200`);
    }
  }
  if (value.pricing !== undefined) {
    if (!isObject(value.pricing)) throw new Error("pricing must be an object");
    if (value.pricing.codex !== undefined) {
      if (!isObject(value.pricing.codex)) throw new Error("pricing.codex must be an object");
      for (const [model, price] of Object.entries(value.pricing.codex)) validatePrice(price, `pricing.codex.${model}`);
    }
    if (value.pricing.jev !== undefined) validatePrice(value.pricing.jev, "pricing.jev");
  }
  return value as Suite;
}

async function runCommand(command: Command, cwd: string, timeoutSeconds: number, onLine?: (line: string) => void, capture = false): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let output = "";
    let timedOut = false;
    let oversized = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 2000);
      escalation.unref();
    }, timeoutSeconds * 1000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (onLine) {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          onLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
        if (buffer.length > 10_000_000) { oversized = true; child.kill("SIGTERM"); }
      } else if (capture && output.length < 100_000) output += chunk;
    });
    child.stderr.resume();
    child.once("error", error => { clearTimeout(timer); if (escalation) clearTimeout(escalation); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (buffer && onLine) onLine(buffer);
      if (oversized) reject(new Error("Codex emitted an oversized JSON event"));
      else resolveResult({ code, timedOut, stdout: output.trim() });
    });
  });
}

async function checkedCommand(command: Command, cwd: string, timeoutSeconds: number, capture = false): Promise<string> {
  const result = await runCommand(command, cwd, timeoutSeconds, undefined, capture);
  if (result.code !== 0 || result.timedOut) throw new Error(`Command failed: ${command[0]}`);
  return result.stdout;
}

function hasGitRepository(directory: string): boolean {
  try { return execFileSync("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() === "true"; }
  catch { return false; }
}

function readAgentsFile(directory: string): Buffer {
  const names = readdirSync(directory);
  const candidates = [...(names.includes("AGENTS.md") ? ["AGENTS.md"] : []), ...names.filter(entry => entry !== "AGENTS.md" && entry.toLowerCase() === "agents.md")];
  const name = candidates.find(entry => {
    try { return statSync(join(directory, entry)).isFile(); }
    catch { return false; }
  });
  if (!name) throw new Error("The benchmark project needs an AGENTS.md file at its root; any letter case is accepted");
  return readFileSync(join(directory, name));
}

function installCanonicalAgents(directory: string, agents: Buffer): void {
  for (const name of readdirSync(directory)) {
    if (name.toLowerCase() === "agents.md") rmSync(join(directory, name), { recursive: true, force: true });
  }
  writeFileSync(join(directory, "AGENTS.md"), agents);
}

function isPathInside(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function cloneAt(repository: string, revision: string, destination: string, agents: Buffer): Promise<void> {
  await checkedCommand(["git", "clone", "--quiet", "--no-hardlinks", "--no-checkout", repository, destination], repository, 300);
  await checkedCommand(["git", "-C", destination, "checkout", "--quiet", "--detach", revision], repository, 120);
  installCanonicalAgents(destination, agents);
}

function snapshotAt(repository: string, destination: string, agents: Buffer, outputDirectory: string): void {
  const excludedOutput = isPathInside(repository, outputDirectory) && resolve(repository) !== resolve(outputDirectory) ? resolve(outputDirectory) : undefined;
  cpSync(repository, destination, {
    recursive: true,
    filter: source => {
      const path = resolve(source);
      if (path === resolve(repository)) return true;
      const name = basename(path);
      if (name === ".git" || name === ".jev" || name === "node_modules") return false;
      if (excludedOutput && (path === excludedOutput || path.startsWith(`${excludedOutput}${sep}`))) return false;
      return true;
    }
  });
  installCanonicalAgents(destination, agents);
}

async function setup(commands: Command[] | undefined, cwd: string): Promise<void> {
  for (const command of commands ?? []) await checkedCommand(command, cwd, 600);
}

async function check(commands: Command[], cwd: string): Promise<Array<number | null>> {
  const codes: Array<number | null> = [];
  for (const command of commands) {
    try { const result = await runCommand(command, cwd, 120); codes.push(result.timedOut ? null : result.code); }
    catch { codes.push(null); }
  }
  return codes;
}

function priceUsage(usage: CodexUsage | undefined, price: Price | undefined): number | undefined {
  if (!usage || !price || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return undefined;
  const cached = Math.max(0, Math.min(usage.input_tokens, usage.cached_input_tokens ?? 0));
  return (Math.max(0, usage.input_tokens - cached) * price.inputUsdPerMillion + cached * (price.cachedInputUsdPerMillion ?? price.inputUsdPerMillion) + usage.output_tokens * price.outputUsdPerMillion) / 1_000_000;
}

function priceJevCodex(job: Job, prices: Record<string, Price> | undefined): number | undefined {
  const routes = job.execution?.metrics?.routes;
  if (!prices || !routes?.length) return undefined;
  const routePrices = routes.map(route => priceUsage(route.usage, prices[route.model]));
  if (routePrices.every((price): price is number => price !== undefined)) return routePrices.reduce((sum, price) => sum + price, 0);
  const models = new Set(routes.map(route => route.model));
  return models.size === 1 ? priceUsage(job.execution?.usage, prices[routes[0].model]) : undefined;
}

function providerPrice(usage: JevTokenUsage, price: Pick<Price, "inputUsdPerMillion" | "outputUsdPerMillion"> | undefined): number | undefined {
  if (!price || usage.missingCalls) return undefined;
  return (usage.inputTokens * price.inputUsdPerMillion + usage.outputTokens * price.outputUsdPerMillion) / 1_000_000;
}

async function baselineRun(task: Task, cwd: string, model: string, reasoning: string, threadId: string | undefined, price: Price | undefined): Promise<ModeResult> {
  const started = seconds();
  const usage: CodexUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  let completedTurns = 0;
  let nextThreadId = threadId;
  const args = [...codexExecPrefix(Boolean(threadId)), "--json", "--skip-git-repo-check", "--model", model, "-c", `model_reasoning_effort="${reasoning}"`, ...(threadId ? [threadId] : []), task.prompt];
  const result = await runCommand(["codex", ...args], cwd, task.timeoutSeconds ?? 1800, line => {
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: string; usage?: CodexUsage };
      if (event.type === "thread.started" && event.thread_id) nextThreadId = event.thread_id;
      if (event.type === "turn.completed" && typeof event.usage?.input_tokens === "number" && typeof event.usage.output_tokens === "number") {
        completedTurns += 1;
        for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"] as const) usage[key] = (usage[key] ?? 0) + (event.usage[key] ?? 0);
      }
    } catch { /* Ignore non-JSON diagnostic lines. */ }
  });
  const elapsed = seconds() - started;
  const checkExitCodes = await check(task.checks, cwd);
  const measured = completedTurns ? usage : undefined;
  return { status: result.timedOut ? "timeout" : result.code === 0 ? "completed" : "failed", seconds: elapsed, usage: measured, codexTokens: totalTokens(measured), cachedInputTokens: measured?.cached_input_tokens, estimatedCostUsd: priceUsage(measured, price), checkExitCodes, passed: result.code === 0 && !result.timedOut && checkExitCodes.every(code => code === 0), threadId: nextThreadId };
}

async function jevRun(task: Task, cwd: string, queue: JobQueue, orchestrator: Orchestrator, job: Job, preparationUsage: JevTokenUsage, preparationSeconds: number, hookUsageFile: string, prices: Record<string, Price> | undefined, jevPrice: Pick<Price, "inputUsdPerMillion" | "outputUsdPerMillion"> | undefined): Promise<ModeResult> {
  const started = seconds();
  let timedOut = false;
  const killed = new Set<number>();
  const watchdog = setInterval(() => {
    if (seconds() - started < (task.timeoutSeconds ?? 1800)) return;
    timedOut = true;
    const current = queue.get(job.id);
    const pid = current?.status === "RUNNING" || current?.status === "ESCALATING" ? current?.execution?.pid : undefined;
    if (pid && !killed.has(pid)) {
      killed.add(pid);
      try { process.kill(pid, "SIGTERM"); } catch { /* The child may have exited. */ }
    }
  }, 1000);
  let measured: Awaited<ReturnType<typeof collectJevUsage<Job>>>;
  const previousUsageFile = process.env.JEV_BENCHMARK_USAGE_FILE;
  process.env.JEV_BENCHMARK_USAGE_FILE = hookUsageFile;
  try { measured = await collectJevUsage(() => orchestrator.run(job.id)); }
  finally {
    clearInterval(watchdog);
    if (previousUsageFile === undefined) delete process.env.JEV_BENCHMARK_USAGE_FILE;
    else process.env.JEV_BENCHMARK_USAGE_FILE = previousUsageFile;
  }
  const { result, usage } = measured;
  const hookUsage = readJevUsageFile(hookUsageFile);
  const providerUsage: JevTokenUsage = {
    inputTokens: preparationUsage.inputTokens + usage.inputTokens + hookUsage.inputTokens,
    outputTokens: preparationUsage.outputTokens + usage.outputTokens + hookUsage.outputTokens,
    totalTokens: preparationUsage.totalTokens + usage.totalTokens + hookUsage.totalTokens,
    calls: preparationUsage.calls + usage.calls + hookUsage.calls,
    missingCalls: preparationUsage.missingCalls + usage.missingCalls + hookUsage.missingCalls
  };
  const elapsed = seconds() - started + preparationSeconds;
  const checkExitCodes = await check(task.checks, cwd);
  const codexCost = priceJevCodex(result, prices);
  const jevCost = providerPrice(providerUsage, jevPrice);
  return { status: timedOut ? "timeout" : result.status.toLowerCase(), seconds: elapsed, usage: result.execution?.usage, codexTokens: totalTokens(result.execution?.usage), cachedInputTokens: result.execution?.usage?.cached_input_tokens, estimatedCostUsd: codexCost !== undefined && jevCost !== undefined ? codexCost + jevCost : undefined, checkExitCodes, passed: !timedOut && result.status === "SUCCESS" && checkExitCodes.every(code => code === 0), threadId: result.execution?.threadId, providerUsage, routes: result.execution?.metrics?.routes.map(route => ({ stage: route.stage, model: route.model, reasoning: route.reasoning })) };
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function comparable(row: TaskResult): boolean {
  return Boolean(row.baseline?.passed && row.jev?.passed && row.baseline.codexTokens !== undefined && row.baseline.codexTokens > 0 && row.jev.codexTokens !== undefined && row.baseline.seconds > 0);
}

function formatPercent(change: number): string {
  if (Math.abs(change) < 0.05) return "0.0%";
  return `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
}

function percentChange(baseline: number, jev: number): string {
  return formatPercent(100 * (jev / baseline - 1));
}

function formatTime(value: number, total = false): string {
  return total && value >= 60 ? `${(value / 60).toFixed(1)} min` : `${value.toFixed(1)} s`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function summary(results: TaskResult[]): string[] {
  const paired = results.filter(comparable);
  const change = (rows: TaskResult[]) => median(rows.map(row => 100 * (row.jev!.codexTokens! / row.baseline!.codexTokens! - 1)));
  const lines = [
    `- Planned tasks: ${results.length}; both passed with token usage: ${paired.length}.`,
    `- Baseline passed: ${results.filter(row => row.baseline?.passed).length}; JEV passed: ${results.filter(row => row.jev?.passed).length}.`,
    `- Median Codex token change on tasks both passed: ${paired.length ? formatPercent(change(paired)!) : "unavailable"} (input + output, cached input included once).`
  ];
  for (const category of [...new Set(paired.map(row => row.category).filter((value): value is string => Boolean(value)))]) {
    const rows = paired.filter(row => row.category === category);
    lines.push(`- ${category}: ${rows.length} paired pass(es), median change ${formatPercent(change(rows)!)}.`);
  }
  return lines;
}

function markdown(report: Report): string {
  const lines = ["# JEV benchmark results", "", `Generated: ${report.generatedAt}`, `Suite snapshot: suite.json`, `JEV revision: ${report.engineRevision}${report.engineDirty ? " (working tree changed)" : ""}`, `Repetitions: ${report.repetitions}`, "", "## Summary", "", ...summary(report.results), "", "Results are exploratory until the suite includes enough representative tasks and repetitions. A percentage change is reported only for pairs where both independent checks passed and Codex usage is complete.", "", "## Task results", "", "Consumption is Codex input plus output tokens; performance is elapsed agent time. Δ % = (JEV − baseline) / baseline × 100, so negative values favor JEV. TOTAL includes only comparable passing pairs.", "", "<table>", "<thead>", "<tr><th rowspan=\"2\">Task</th><th colspan=\"3\" align=\"center\">Consumption</th><th colspan=\"3\" align=\"center\">Performance</th></tr>", "<tr><th align=\"right\">Baseline</th><th align=\"right\">JEV</th><th align=\"right\">Δ %</th><th align=\"right\">Baseline</th><th align=\"right\">JEV</th><th align=\"right\">Δ %</th></tr>", "</thead>", "<tbody>"];
  for (const row of report.results) {
    const baseline = row.baseline;
    const jev = row.jev;
    const paired = comparable(row);
    const tokens = (mode?: ModeResult) => mode?.codexTokens === undefined ? "—" : mode.codexTokens.toLocaleString("en-US");
    const elapsed = (mode?: ModeResult) => mode ? formatTime(mode.seconds) : "—";
    const task = `${row.scenario} / ${row.task}${report.repetitions > 1 ? ` (repeat ${row.repetition})` : ""}`;
    lines.push(`<tr><th scope="row">${escapeHtml(task)}</th><td align="right">${tokens(baseline)}</td><td align="right">${tokens(jev)}</td><td align="right">${paired ? percentChange(baseline!.codexTokens!, jev!.codexTokens!) : "—"}</td><td align="right">${elapsed(baseline)}</td><td align="right">${elapsed(jev)}</td><td align="right">${paired ? percentChange(baseline!.seconds, jev!.seconds) : "—"}</td></tr>`);
  }
  const paired = report.results.filter(comparable);
  const totals = paired.reduce((result, row) => ({ baselineTokens: result.baselineTokens + row.baseline!.codexTokens!, jevTokens: result.jevTokens + row.jev!.codexTokens!, baselineSeconds: result.baselineSeconds + row.baseline!.seconds, jevSeconds: result.jevSeconds + row.jev!.seconds }), { baselineTokens: 0, jevTokens: 0, baselineSeconds: 0, jevSeconds: 0 });
  lines.push("</tbody>", "<tfoot>", `<tr><th scope="row">TOTAL</th><th align="right">${paired.length ? totals.baselineTokens.toLocaleString("en-US") : "—"}</th><th align="right">${paired.length ? totals.jevTokens.toLocaleString("en-US") : "—"}</th><th align="right">${paired.length ? percentChange(totals.baselineTokens, totals.jevTokens) : "—"}</th><th align="right">${paired.length ? formatTime(totals.baselineSeconds, true) : "—"}</th><th align="right">${paired.length ? formatTime(totals.jevSeconds, true) : "—"}</th><th align="right">${paired.length ? percentChange(totals.baselineSeconds, totals.jevSeconds) : "—"}</th></tr>`, "</tfoot>", "</table>", "", "## Run details", "", "| Scenario / task | Repeat | Route | Baseline | JEV | JEV provider tokens | Cost B/J |", "| --- | ---: | --- | --- | --- | ---: | --- |");
  for (const row of report.results) {
    const status = (mode?: ModeResult) => mode ? `${mode.status} / ${mode.passed ? "pass" : mode.checkExitCodes.some(code => code !== 0) ? "check failed" : "fail"}` : row.error?.startsWith("Skipped") ? "skipped" : "unavailable";
    const cost = (mode?: ModeResult) => mode?.estimatedCostUsd !== undefined ? money(mode.estimatedCostUsd) : "—";
    const values = [`${row.scenario} / ${row.task}`, String(row.repetition), row.model ? `${row.model} ${row.reasoning}` : "—", status(row.baseline), status(row.jev), String(row.jev?.providerUsage?.totalTokens ?? "—"), `${cost(row.baseline)} / ${cost(row.jev)}`];
    lines.push(`| ${values.map(value => value.replaceAll("|", "\\|")).join(" | ")} |`);
  }
  lines.push("", "## Check failures and skipped tasks", "");
  for (const row of report.results) {
    const failed = (mode?: ModeResult) => mode?.checkExitCodes.flatMap((code, index) => code === 0 ? [] : [`check ${index + 1}: ${code === null ? "unavailable or timed out" : `exit ${code}`}`]).join(", ");
    const details = [row.baseline && failed(row.baseline) ? `baseline ${failed(row.baseline)}` : "", row.jev && failed(row.jev) ? `JEV ${failed(row.jev)}` : "", row.error ?? ""].filter(Boolean);
    if (details.length) lines.push(`- ${row.scenario} / ${row.task}: ${details.join("; ")}.`);
  }
  if (lines.at(-1) === "") lines.push("- None.");
  const sourceNote = report.sourceIsGit
    ? "- Each variant starts from its selected Git commit, with the current AGENTS.md snapshot saved beside this report; a scenario retains its own edits and thread between tasks."
    : "- Each variant starts from the same filesystem snapshot copied at launch, with AGENTS.md saved beside this report; `.git`, `.jev`, `node_modules`, and the benchmark output directory are omitted. A scenario retains its own edits and thread between tasks.";
  lines.push("", "## Measurement notes", "", sourceNote, "- Codex tokens are the sum of completed turn usage. Cached input is part of input tokens and is also recorded separately in results.json.", "- Independent checks run after each variant and do not count toward agent tokens or duration.", "- JEV provider usage includes analysis, verification, continuity and separate hook responses when the provider reports usage. The JSON report marks missing usage calls.", "- USD estimates appear in results.json only when the suite supplies prices and all required usage is available. Prices are supplied by the suite author, not fetched live.", "- Failed or incomplete pairs remain visible but are excluded from percentage changes and totals.", "");
  return lines.join("\n");
}

/** Render a stored benchmark report as Markdown without starting agents. */
export function markdownReport(report: Report): string { return markdown(report); }

function writeReport(directory: string, report: Report): void {
  writeFileSync(join(directory, "results.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(directory, "report.md"), markdown(report));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2 || args[0] !== "--suite" || args.some(arg => arg === "--help" || arg === "-h")) throw new Error("Usage: npm run benchmark -- --suite benchmarks/demo.json [--output path] [--dry-run]");
  const suiteFile = resolve(args[1]);
  const outputIndex = args.indexOf("--output");
  if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error("--output needs a directory");
  const dryRun = args.includes("--dry-run");
  if (args.some((arg, index) => index > 1 && arg !== "--dry-run" && arg !== "--output" && index !== outputIndex + 1)) throw new Error("Unknown benchmark option");
  const suite = loadSuite(suiteFile);
  const repository = resolve(dirname(suiteFile), suite.repository);
  const agents = readAgentsFile(repository);
  const sourceIsGit = hasGitRepository(repository);
  if (!sourceIsGit && (suite.revision !== undefined || suite.scenarios.some(scenario => scenario.revision !== undefined))) throw new Error("This benchmark project is not a Git repository; omit revision fields to use its current filesystem snapshot");
  const revisions = new Map<string, string>();
  if (sourceIsGit) {
    for (const scenario of suite.scenarios) {
      const revision = scenario.revision ?? suite.revision;
      if (!revision) throw new Error("Git benchmark suites need a revision at suite level or for every scenario");
      if (!revisions.has(revision)) revisions.set(revision, await checkedCommand(["git", "-C", repository, "rev-parse", "--verify", `${revision}^{commit}`], repository, 30, true));
    }
  }
  const count = suite.scenarios.reduce((sum, scenario) => sum + scenario.tasks.length, 0) * (suite.repetitions ?? 1);
  if (dryRun) { process.stdout.write(`Benchmark plan: ${count} paired task runs across ${suite.scenarios.length} scenario(s). No agents started.\n`); return; }
  if (!new AppConfigStore().read().aiGatewayApiKey) throw new Error("Configure Vercel AI Gateway in JEV Settings before running the benchmark");
  const directory = resolve(outputIndex >= 0 ? args[outputIndex + 1] : join(".jev", "benchmarks", new Date().toISOString().replace(/[:.]/g, "-")));
  if (existsSync(directory)) throw new Error("The output directory already exists");
  mkdirSync(dirname(directory), { recursive: true });
  mkdirSync(directory);
  copyFileSync(suiteFile, join(directory, "suite.json"));
  writeFileSync(join(directory, "AGENTS.md"), agents);
  const engineRevision = await checkedCommand(["git", "rev-parse", "HEAD"], process.cwd(), 30, true);
  const engineDirty = Boolean(await checkedCommand(["git", "status", "--porcelain"], process.cwd(), 30, true));
  const report: Report = { suite: suiteFile, generatedAt: new Date().toISOString(), source: repository, sourceIsGit, engineRevision, engineDirty, repetitions: suite.repetitions ?? 1, results: [] };
  writeReport(directory, report);
  process.stdout.write(`Benchmark results: ${directory}\n`);
  for (let repetition = 1; repetition <= report.repetitions; repetition++) {
    for (const [scenarioIndex, scenario] of suite.scenarios.entries()) {
      const revision = sourceIsGit ? revisions.get(scenario.revision ?? suite.revision!)! : "working-tree snapshot";
      const trial = join(directory, `${scenario.id}-${repetition}`);
      mkdirSync(trial);
      const baselineDirectory = join(trial, "baseline");
      const jevDirectory = join(trial, "jev");
      if (sourceIsGit) {
        await cloneAt(repository, revision, baselineDirectory, agents);
        await cloneAt(repository, revision, jevDirectory, agents);
      } else {
        snapshotAt(repository, baselineDirectory, agents, directory);
        snapshotAt(repository, jevDirectory, agents, directory);
      }
      await setup(scenario.setup, baselineDirectory);
      await setup(scenario.setup, jevDirectory);
      const stateDirectory = join(trial, "state");
      const project = new ProjectStore(stateDirectory).create(jevDirectory);
      const queue = new JobQueue(stateDirectory);
      const orchestrator = new Orchestrator(queue);
      let baselineThread: string | undefined;
      for (const [taskIndex, task] of scenario.tasks.entries()) {
        await setup(task.setup, baselineDirectory);
        await setup(task.setup, jevDirectory);
        const row: TaskResult = { scenario: scenario.id, repetition, task: task.id, category: task.category, revision, model: "", reasoning: "" };
        report.results.push(row);
        process.stdout.write(`[${repetition}/${report.repetitions}] ${scenario.id}/${task.id}: preparing JEV route\n`);
        try {
          const job = queue.create(project.id, jevDirectory, [{ description: task.prompt }]);
          const preparationStarted = seconds();
          const prepared = await collectJevUsage(() => orchestrator.prepare(job));
          const preparationSeconds = seconds() - preparationStarted;
          if (!prepared.result?.analysis) throw new Error("JEV did not return a route");
          const model = await activeCodexModelId(prepared.result.analysis.model);
          const reasoning = prepared.result.analysis.reasoning;
          row.model = model;
          row.reasoning = reasoning;
          const price = suite.pricing?.codex?.[model];
          const baseline = async () => { row.baseline = await baselineRun(task, baselineDirectory, model, reasoning, baselineThread, price); baselineThread = row.baseline.threadId; };
          const jev = async () => { row.jev = await jevRun(task, jevDirectory, queue, orchestrator, job, prepared.usage, preparationSeconds, join(stateDirectory, `${task.id}-hook-usage.jsonl`), suite.pricing?.codex, suite.pricing?.jev); };
          if ((repetition + scenarioIndex + taskIndex) % 2) { await baseline(); await jev(); }
          else { await jev(); await baseline(); }
          process.stdout.write(`  baseline ${row.baseline?.passed ? "pass" : "fail"}; JEV ${row.jev?.passed ? "pass" : "fail"}\n`);
        } catch {
          row.error = "The paired run could not complete; inspect local environment and configuration";
          process.stdout.write(`  incomplete; see results.json\n`);
        }
        writeReport(directory, report);
        if (!row.baseline?.passed || !row.jev?.passed) {
          for (const remaining of scenario.tasks.slice(taskIndex + 1)) report.results.push({ scenario: scenario.id, repetition, task: remaining.id, category: remaining.category, revision, model: "", reasoning: "", error: "Skipped because the preceding ticket did not pass in both variants" });
          writeReport(directory, report);
          break;
        }
      }
    }
  }
  process.stdout.write(`Finished. Open ${join(directory, "report.md")}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(error => {
  process.stderr.write(`benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
