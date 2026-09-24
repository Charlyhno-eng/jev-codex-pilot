import { readProjectFile } from "./project-reader.js";
import { AppConfigStore } from "./app-config.js";
import { createConfiguredJevProvider, type JevDecision } from "./jev-provider.js";
import { estimateJevInputCost } from "./jev-pricing.js";
import { logJev, logJevError } from "./jev-logger.js";
import { defaultRoute } from "./codex-models.js";
import type { Complexity, JevAnalysis, Job, TaskSpec } from "./types.js";

export type TaskEvaluator = (state: string) => Promise<JevDecision>;
export type ContinuityEvaluator = (state: string) => Promise<"related" | "unrelated" | "uncertain">;

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

/** Analyzes a task and selects its Codex route. */
export async function analyze(projectPath: string, tasks: TaskSpec[], evaluator: TaskEvaluator = createConfiguredJevProvider(new AppConfigStore().read()).evaluate): Promise<JevAnalysis> {
  if (tasks.length !== 1) throw new Error("JEV requires exactly one task per analysis");
  const description = tasks[0].description;
  const agents = readProjectFile(projectPath, "AGENTS.md");

  let decision: JevDecision;
  try {
    decision = await evaluator(JSON.stringify({
      task: description,
      project: { agents: agents?.slice(0, 12_000) ?? null }
    }));
  } catch (error) {
    logJevError(`Task evaluation failed · ${describeError(error)}`);
    throw new Error(`JEV analysis failed: ${describeError(error)}`);
  }

  const complexity = Math.max(1, Math.min(5, Math.round(decision.complexity))) as Complexity;
  const policy = defaultRoute(complexity);

  const analysis: JevAnalysis = {
    complexity,
    outcome_clarity_score: decision.outcomeClarityScore,
    task_types: [decision.taskType],
    model: policy.model,
    reasoning: policy.reasoning,
    rationale: [
      `TypeSafe JEV classified this task as ${decision.taskType}.`,
      "This recommendation applies to this task only; it will run in its own Codex session.",
      `Complexity ${complexity}/5 selects ${policy.model} with ${policy.reasoning} reasoning from config/model.toml.`,
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
  return analysis;
}

/** Asks JEV whether the next ticket needs the completed ticket's conversation. */
export async function assessTaskContinuity(completed: Job[], next: Job, evaluator: ContinuityEvaluator = createConfiguredJevProvider(new AppConfigStore().read()).evaluateContinuity): Promise<"related" | "unrelated" | "uncertain"> {
  logJev(`Codex thread continuity review started · completed ${completed.map(job => job.id.slice(0, 8)).join(", ")} · next ${next.id.slice(0, 8)}`);
  const decision = await evaluator(JSON.stringify({
    completed: completed.map(job => ({ task: job.tasks.map(task => task.description).join("\n") })),
    next: { task: next.tasks.map(task => task.description).join("\n") }
  }));
  logJev(`Codex thread continuity review complete · ${decision}`);
  return decision;
}
