import { basename, extname } from "node:path";
import { listProjectFiles, readProjectFile } from "./project-reader.js";
import { AppConfigStore } from "./app-config.js";
import { createConfiguredJevProvider, type JevDecision } from "./jev-provider.js";
import { estimateJevInputCost } from "./jev-pricing.js";
import type { CodexModel, Complexity, JevAnalysis, Reasoning, TaskSpec, TaskType } from "./types.js";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php", ".vue", ".svelte"]);

export type TaskEvaluator = (state: string) => Promise<JevDecision>;

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

function selectPolicy(taskType: TaskType, complexity: Complexity): { model: CodexModel; reasoning: Reasoning; reason: string } {
  if (complexity === "trivial") return { model: "luna", reasoning: "low", reason: "The task is tiny and deterministic, so it uses the lowest-cost Codex setting." };
  if (taskType === "installation") return { model: "luna", reasoning: "medium", reason: "Installation is a routine, bounded operation." };
  if (complexity === "low") return { model: "luna", reasoning: "low", reason: "The task is small and bounded, so it uses the lowest-cost Codex setting." };
  if (taskType === "ui_ux") {
    if (complexity === "very_high") return { model: "sol", reasoning: "high", reason: "This UI/UX task is broad enough to need deeper implementation reasoning." };
    if (complexity === "high") return { model: "sol", reasoning: "medium", reason: "This UI/UX task is substantial enough to need Sol." };
    return { model: "terra", reasoning: "medium", reason: "This UI/UX task is substantial but does not require the highest model." };
  }
  if (taskType === "architecture" || taskType === "security") {
    return complexity === "high" || complexity === "very_high"
      ? { model: "sol", reasoning: "high", reason: "Architecture or security work needs deeper cross-project reasoning." }
      : { model: "terra", reasoning: "medium", reason: "The scoped architecture or security task needs balanced reasoning." };
  }
  if (complexity === "medium") return { model: "terra", reasoning: "medium", reason: "Several related changes require balanced implementation reasoning." };
  return { model: "sol", reasoning: complexity === "very_high" ? "high" : "medium", reason: "This task spans several substantial changes." };
}

export async function analyze(projectPath: string, tasks: TaskSpec[], evaluator: TaskEvaluator = createConfiguredJevProvider(new AppConfigStore().read()).evaluate): Promise<JevAnalysis> {
  if (tasks.length !== 1) throw new Error("JEV requires exactly one task per analysis");
  const description = tasks[0].description;
  const files = listProjectFiles(projectPath);
  const names = new Set(files.map(file => file.path));
  const agents = readProjectFile(projectPath, "AGENTS.md");

  let decision: JevDecision;
  try {
    decision = await evaluator(JSON.stringify({
      task: description,
      project: {
        fileCount: files.length,
        files: files.slice(0, 300).map(file => file.path),
        agents: agents?.slice(0, 12_000) ?? null
      }
    }));
  } catch (error) {
    throw new Error(`JEV analysis failed: ${describeError(error)}`);
  }

  const explicit = mentions(description);
  const words = unique(description.toLowerCase().match(/[\p{L}\d_-]{4,}/gu) ?? []);
  const installationOnly = decision.taskType === "installation";
  const scored = files.map(file => {
    const lower = file.path.toLowerCase();
    let score = explicit.includes(file.path) ? 100 : 0;
    score += words.filter(word => lower.includes(word)).length * 10;
    if (basename(file.path).toLowerCase() === "agents.md") score += 50;
    if (/^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|cargo\.toml|go\.mod|tsconfig\.json|dockerfile)$/i.test(basename(file.path))) score += installationOnly ? 40 : 5;
    return { ...file, score };
  });
  let context = scored.filter(file => file.score > 0).sort((a, b) => b.score - a.score || a.size - b.size).slice(0, 12).map(file => file.path);
  const projectGuidance = ["AGENTS.md", "README.md"].filter(file => names.has(file));
  context = unique([...projectGuidance, ...context]);
  if (context.length === 0) context.push(...files.filter(file => CODE_EXTENSIONS.has(extname(file.path))).slice(0, 4).map(file => file.path));

  const filesToModify = explicit.filter(file => names.has(file));
  if (installationOnly) {
    filesToModify.push(...files.filter(file => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|cargo\.toml|go\.mod)$/i.test(file.path)).map(file => file.path));
  }
  const policy = selectPolicy(decision.taskType, decision.complexity);

  return {
    complexity: decision.complexity,
    complexity_score: decision.complexityScore,
    task_types: [decision.taskType],
    model: policy.model,
    reasoning: policy.reasoning,
    context_files: unique(context),
    files_to_modify: unique(filesToModify),
    rationale: [
      `TypeSafe JEV classified this task as ${decision.taskType} with ${decision.complexity} complexity.`,
      "This recommendation applies to this task only; it will run in its own Codex session.",
      policy.reason,
      `${context.length} relevant file(s) selected out of ${files.length}; AGENTS.md has priority.`,
      agents ? "Project instructions from AGENTS.md were detected." : "No AGENTS.md was found in the target project.",
      "Astra is disabled by policy."
    ],
    evaluator: "typesafe-ai/jev",
    evaluation_usage: decision.usage ? {
      input_tokens: decision.usage.inputTokens,
      output_tokens: decision.usage.outputTokens,
      total_tokens: decision.usage.totalTokens,
      estimated_cost_usd: estimateJevInputCost(decision.usage.inputTokens ?? decision.usage.totalTokens ?? 0)
    } : undefined
  };
}
