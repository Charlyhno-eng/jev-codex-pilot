import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate } from "ai";
import type { AppConfig } from "./app-config.js";
import { JEV_INPUT_USD_PER_MILLION_TOKENS } from "./jev-pricing.js";
import type { Complexity, TaskType } from "./types.js";

export type JevDecision = {
  taskType: TaskType;
  complexity: Complexity;
  taskPrecision?: number;
  decompositionScore?: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

export type JevTaskPrecision = {
  score: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

export type JevProvider = {
  id: string;
  inputUsdPerMillionTokens: number;
  evaluate(state: string): Promise<JevDecision>;
  evaluateTaskPrecision(state: string): Promise<JevTaskPrecision>;
};

const TASK_TYPE_CRITERIA: Record<TaskType, string> = {
  installation: "Only installing, removing, or updating packages, dependencies, runtimes, or project tooling.",
  feature: "Implementing new application behavior or product functionality that is not primarily visual design.",
  bugfix: "Diagnosing and correcting incorrect existing behavior.",
  ui_ux: "Creating or substantially changing visual design, layout, styling, accessibility, animation, or user interaction.",
  refactoring: "Improving internal code structure without intentionally changing product behavior.",
  testing: "Creating, repairing, or expanding automated tests and coverage.",
  documentation: "Writing or updating documentation, guides, comments, or examples.",
  configuration: "Changing configuration, CI, deployment, build tools, or developer operations beyond package installation.",
  architecture: "Designing system boundaries, components, contracts, or a technical implementation plan.",
  performance: "Measuring or improving speed, latency, memory, bundle size, or resource consumption.",
  security: "Auditing or improving authentication, authorization, secrets, validation, or security posture.",
  database: "Changing schemas, migrations, persistence, queries, or data models.",
  research: "Investigation, comparison, or reflection where implementation is not the primary requested outcome."
};

export const TASK_PRECISION_CRITERIA = [
  "0% — no actionable outcome, scope, or useful relation to the project context.",
  "15% — a broad request with little indication of the expected result.",
  "30% — an outcome is hinted at, but the intended behavior is still unclear.",
  "45% — a concrete intent is present, with several important ambiguities remaining.",
  "55% — the main outcome is understandable, but key constraints or acceptance expectations are absent.",
  "65% — the task is workable and identifies a concrete outcome, though Codex will make some assumptions.",
  "75% — the requested behavior is specific and scoped enough for normal implementation in the supplied context.",
  "83% — the task has clear behavior, useful boundaries, and relevant project context.",
  "92% — the task has clear behavior, boundaries, and useful acceptance expectations.",
  "100% — the requested outcome, scope, constraints, and success criteria are unambiguous in context."
] as const;

const TASK_PRECISION_PERCENTAGES = [0, 15, 30, 45, 55, 65, 75, 83, 92, 100] as const;
const TASK_DECOMPOSITION_PERCENTAGES = [0, 10, 20, 35, 45, 55, 65, 75, 90, 100] as const;
export const TASK_DECOMPOSITION_CRITERIA = [
  "0% — several unrelated outcomes are mixed in one ticket.",
  "10% — many independent features or projects are combined.",
  "20% — multiple substantial deliverables should be separated.",
  "35% — the ticket spans several distinct behaviors with separate acceptance checks.",
  "45% — a broad task could be split into clearer, independently useful tickets.",
  "55% — mostly one goal, with a few separable extras.",
  "65% — one main outcome with related supporting steps.",
  "75% — a coherent unit of work with clear boundaries.",
  "90% — a focused ticket whose steps belong together.",
  "100% — one independently deliverable outcome with no unrelated work."
] as const;
/** Performs this backend operation. */
export function taskPrecisionPercentage(level: number) { return TASK_PRECISION_PERCENTAGES[Math.max(0, Math.min(TASK_PRECISION_PERCENTAGES.length - 1, Math.round(level)))]!; }

/** Converts a task-breakdown score to its visible percentage. */
export function taskDecompositionPercentage(level: number) { return TASK_DECOMPOSITION_PERCENTAGES[Math.max(0, Math.min(TASK_DECOMPOSITION_PERCENTAGES.length - 1, Math.round(level)))]!; }

/** Performs this backend operation. */
export function createVercelGatewayJevProvider(config: AppConfig): JevProvider {
  if (!config.aiGatewayApiKey) throw new Error("Configure a Vercel AI Gateway API key before analyzing a task.");
  const model = createGateway({ apiKey: config.aiGatewayApiKey }).evaluationModel("typesafe-ai/jev");
  return {
    id: "vercel-ai-gateway/typesafe-ai/jev",
    inputUsdPerMillionTokens: JEV_INPUT_USD_PER_MILLION_TOKENS,
    async evaluate(state) {
      const result = await evaluate({
        model,
        state,
        questions: {
          taskType: {
            type: "choice",
            criteria: TASK_TYPE_CRITERIA,
            instructions: "Choose the single primary software-development task type. Classify the requested outcome, not incidental steps. A request for a polished interface is UI/UX even when it also requires code."
          },
          complexity: {
            type: "choice",
            criteria: {
              trivial: "A tiny deterministic change or lookup with negligible implementation judgment.",
              low: "A routine, bounded task affecting a small and well-understood area.",
              medium: "A normal feature or change requiring several coordinated implementation decisions.",
              high: "A broad or technically difficult task spanning important subsystems or significant uncertainty.",
              very_high: "An exceptional, project-wide task with substantial ambiguity, risk, or deep cross-system reasoning."
            },
            instructions: "Estimate only this one task. Do not inflate complexity because other tasks may exist, the repository is large, the task is UI work, or the code uses Python. Moving, resizing, or repositioning a few buttons or other UI elements is trivial. Use low for clearly defined routine development such as a small endpoint, component, script, CRUD operation, or unit test."
          },
          taskPrecision: {
            type: "score",
            criteria: TASK_PRECISION_CRITERIA,
            instructions: "Score how precisely this single task is stated for Codex in the supplied AGENTS.md project context. Judge clarity of the requested outcome, boundaries, expected behavior, and relevant constraints. Do not lower the score because implementation will be difficult or because the task does not prescribe technical steps. A concrete request that identifies a visible change, affected area, or intended behavior normally merits at least 65%; use 75% when it is sufficiently specific for normal implementation. Reserve scores below 45% for requests whose expected result remains substantially unclear. This is advisory only."
          },
          decomposition: {
            type: "score",
            criteria: TASK_DECOMPOSITION_CRITERIA,
            instructions: "Assess whether this single ticket is sufficiently split for one Codex task. A high score means one coherent deliverable; a low score suggests dividing independent outcomes into separate tickets. Do not penalize technical difficulty, number of files, or necessary implementation steps. Advisory only; never block execution."
          }
        }
      });
      return {
        taskType: result.answers.taskType.choice,
        complexity: result.answers.complexity.choice,
        taskPrecision: taskPrecisionPercentage(result.answers.taskPrecision.score),
        decompositionScore: taskDecompositionPercentage(result.answers.decomposition.score),
        usage: result.usage
      };
    },
    async evaluateTaskPrecision(state) {
      const result = await evaluate({
        model,
        state,
        questions: {
          precision: {
            type: "score",
            criteria: TASK_PRECISION_CRITERIA,
            instructions: "Score how precisely this single task is stated for Codex in the supplied AGENTS.md project context. Judge clarity of the requested outcome, boundaries, expected behavior, and relevant constraints. Do not lower the score because implementation will be difficult or because the task does not prescribe technical steps. A concrete request that identifies a visible change, affected area, or intended behavior normally merits at least 65%; use 75% when it is sufficiently specific for normal implementation. Reserve scores below 45% for requests whose expected result remains substantially unclear. This is advisory only."
          }
        }
      });
      return {
        score: taskPrecisionPercentage(result.answers.precision.score),
        usage: result.usage
      };
    }
  };
}

/** Performs this backend operation. */
export function createConfiguredJevProvider(config: AppConfig): JevProvider {
  if (config.jevProvider === "vercel-ai-gateway") return createVercelGatewayJevProvider(config);
  throw new Error(`Unknown JEV provider "${config.jevProvider}". Add its adapter in src/core/jev-provider.ts.`);
}
