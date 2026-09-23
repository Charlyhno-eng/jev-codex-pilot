import { basename, extname } from "node:path";
import { listProjectFiles, readProjectFile } from "./project-reader.js";
import { AppConfigStore } from "./app-config.js";
import { createConfiguredJevProvider, type JevDecision } from "./jev-provider.js";
import { estimateJevInputCost } from "./jev-pricing.js";
import { logJev, logJevError } from "./jev-logger.js";
import { defaultRoute } from "./codex-models.js";
import type { JevAnalysis, Job, TaskSpec } from "./types.js";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php", ".vue", ".svelte"]);

export type TaskEvaluator = (state: string) => Promise<JevDecision>;
export type VerificationEvaluator = (state: string) => Promise<boolean>;
export type ContinuityEvaluator = (state: string) => Promise<"related" | "unrelated" | "uncertain">;

function unique<T>(items: T[]): T[] { return [...new Set(items)]; }
function mentions(value: string): string[] {
  return [...value.matchAll(/(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|py|go|rs|vue|svelte|yml|yaml)/g)].map(match => match[0]);
}

function describeError(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const value = current as { message?: unknown; lastError?: unknown; cause?: unknown };
    if (typeof value.message === "string" && !messages.includes(value.message)) messages.push(value.message);
    current = value.lastError ?? value.cause;
  }
  return messages.join(" → ") || String(error);
}

/** Performs this backend operation. */
export async function analyze(projectPath: string, tasks: TaskSpec[], evaluator: TaskEvaluator = createConfiguredJevProvider(new AppConfigStore().read()).evaluate): Promise<JevAnalysis> {
  if (tasks.length !== 1) throw new Error("JEV requires exactly one task per analysis");
  const description = tasks[0].description;
  const files = listProjectFiles(projectPath);
  const names = new Set(files.map(file => file.path));
  const agents = readProjectFile(projectPath, "AGENTS.md");
  const explicit = mentions(description);
  const words = unique(description.toLowerCase().match(/[\p{L}\d_-]{4,}/gu) ?? []);
  const fileCandidates = files
    .map(file => ({ path: file.path, score: (explicit.includes(file.path) ? 100 : 0) + words.filter(word => file.path.toLowerCase().includes(word)).length * 10 }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 120)
    .map(file => file.path);
  logJev(`Task evaluation started · ${files.length} project file(s) read`);

  let decision: JevDecision;
  try {
    decision = await evaluator(JSON.stringify({
      task: description,
      project: {
        fileCount: files.length,
        files: files.slice(0, 300).map(file => file.path),
        fileCandidates,
        agents: agents?.slice(0, 12_000) ?? null
      }
    }));
  } catch (error) {
    logJevError(`Task evaluation failed · ${describeError(error)}`);
    throw new Error(`JEV analysis failed: ${describeError(error)}`);
  }

  const installationOnly = decision.taskType === "installation";
  const scored = files.map(file => {
    const lower = file.path.toLowerCase();
    let score = explicit.includes(file.path) ? 100 : 0;
    score += words.filter(word => lower.includes(word)).length * 10;
    if (basename(file.path).toLowerCase() === "agents.md") score += 50;
    if (/^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|cargo\.toml|go\.mod|tsconfig\.json|dockerfile)$/i.test(basename(file.path))) score += installationOnly ? 40 : 5;
    return { ...file, score };
  });
  const relevant = scored.filter(file => file.score > 0).sort((a, b) => b.score - a.score || a.size - b.size);
  const jevFiles = unique(decision.relevantFiles ?? []).filter(path => names.has(path)).slice(0, 2);
  let context = jevFiles.length ? unique([...jevFiles, ...relevant.filter(file => file.score >= 10).slice(0, 3).map(file => file.path)]) : relevant.slice(0, 8).map(file => file.path);
  const projectGuidance = ["AGENTS.md", "README.md"].filter(file => names.has(file));
  context = unique([...projectGuidance, ...context]);
  if (context.length === 0) context.push(...files.filter(file => CODE_EXTENSIONS.has(extname(file.path))).slice(0, 4).map(file => file.path));

  const filesToModify = unique([...explicit, ...jevFiles, ...relevant.filter(file => CODE_EXTENSIONS.has(extname(file.path)) && basename(file.path).toLowerCase() !== "agents.md").slice(0, jevFiles.length ? 2 : 5).map(file => file.path)]);
  if (installationOnly) {
    filesToModify.push(...files.filter(file => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|cargo\.toml|go\.mod)$/i.test(file.path)).map(file => file.path));
  }
  const policy = defaultRoute(decision.complexity);

  const analysis: JevAnalysis = {
    complexity: decision.complexity,
    outcome_clarity_score: decision.outcomeClarityScore,
    task_types: [decision.taskType],
    model: policy.model,
    reasoning: policy.reasoning,
    context_files: unique(context),
    files_to_modify: unique(filesToModify),
    rationale: [
      `TypeSafe JEV classified this task as ${decision.taskType}.`,
      "This recommendation applies to this task only; it will run in its own Codex session.",
      `Complexity ${decision.complexity}/5 selects ${policy.model} with ${policy.reasoning} reasoning from config/model.toml.`,
      `${context.length} relevant file(s) selected out of ${files.length}; AGENTS.md has priority.`,
      jevFiles.length ? `JEV selected ${jevFiles.join(", ")} as the first implementation files to inspect.` : "No specific implementation file was selected by JEV; local file ranking was used.",
      agents ? "Project instructions from AGENTS.md were detected." : "No AGENTS.md was found in the target project.",
      "Model and effort options for this complexity level are configured in config/model.toml."
    ],
    evaluator: "typesafe-ai/jev",
    evaluation_usage: decision.usage ? {
      input_tokens: decision.usage.inputTokens,
      output_tokens: decision.usage.outputTokens,
      total_tokens: decision.usage.totalTokens,
      estimated_cost_usd: estimateJevInputCost(decision.usage.inputTokens ?? decision.usage.totalTokens ?? 0)
    } : undefined
  };
  logJev(analysis.context_files.length
    ? `Codex context selected · ${analysis.context_files.join(", ")} · ${analysis.context_files.length} file(s) added to Codex context`
    : "Codex context selected · no project files were available for Codex context");
  logJev(`Task evaluation complete · expected outcome clarity ${analysis.outcome_clarity_score ?? "unavailable"}% · complexity ${analysis.complexity}/5 · recommended tier ${analysis.model} with ${analysis.reasoning} reasoning · files ${jevFiles.join(", ") || "ranked locally"}`);
  return analysis;
}

/** Asks JEV whether the tests mapped to actual ticket changes are worthwhile. */
export async function assessVerification(task: string, changedFiles: string[], candidateTests: string[], evaluator: VerificationEvaluator = createConfiguredJevProvider(new AppConfigStore().read()).evaluateVerification): Promise<boolean> {
  logJev(`Targeted verification review started · ${changedFiles.length} changed file(s) · ${candidateTests.length} candidate test(s)`);
  const decision = await evaluator(JSON.stringify({ task, changedFiles, candidateTests }));
  logJev(`Targeted verification review complete · ${decision ? "run affected tests" : "skip tests"}`);
  return decision;
}

/** Asks JEV whether the next ticket needs the completed ticket's conversation. */
export async function assessTaskContinuity(completed: Job[], next: Job, evaluator: ContinuityEvaluator = createConfiguredJevProvider(new AppConfigStore().read()).evaluateContinuity): Promise<"related" | "unrelated" | "uncertain"> {
  logJev(`Codex thread continuity review started · completed ${completed.map(job => job.id.slice(0, 8)).join(", ")} · next ${next.id.slice(0, 8)}`);
  const decision = await evaluator(JSON.stringify({
    completed: completed.map(job => ({ task: job.tasks.map(task => task.description).join("\n"), likelyFiles: job.analysis?.files_to_modify ?? [] })),
    next: { task: next.tasks.map(task => task.description).join("\n"), likelyFiles: next.analysis?.files_to_modify ?? [] }
  }));
  logJev(`Codex thread continuity review complete · ${decision}`);
  return decision;
}
