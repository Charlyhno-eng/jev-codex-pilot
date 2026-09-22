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
  relevantFiles?: string[];
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
  evaluateVerification(state: string): Promise<boolean>;
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
  "20% — no actionable outcome or recognizable change is stated.",
  "20% — the request is too vague to identify the intended result.",
  "40% — a broad goal is recognizable, but the affected behavior remains unclear.",
  "60% — an actionable goal is stated, but an important choice about the outcome remains open.",
  "80% — the requested change and affected area are clear; normal implementation choices can be inferred from project context.",
  "80% — the intended behavior is clear enough to implement with routine assumptions.",
  "80% — a concrete, scoped outcome is described; technical steps need not be prescribed.",
  "80% — the change has clear boundaries and can be implemented without further clarification.",
  "100% — the outcome, boundaries, and relevant constraints are explicit.",
  "100% — the requested result and success conditions are exceptionally clear in context."
] as const;

const TASK_PRECISION_PERCENTAGES = [20, 20, 40, 60, 80, 80, 80, 80, 100, 100] as const;
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

const TASK_PRECISION_INSTRUCTIONS = "Score the clarity of this single task in its AGENTS.md project context. A concrete requested change with an identifiable affected area normally deserves 80%, even when technical steps and acceptance tests are unstated. Use 60% when one important outcome choice remains open, 40% for a broad goal without clear affected behavior, and 20% only when the result cannot be identified. Reserve 100% for exceptionally explicit outcomes and constraints. Do not penalize implementation difficulty, missing file names, or routine assumptions. This score is advisory only.";

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
      const project = JSON.parse(state) as { project?: { fileCandidates?: string[] } };
      const candidates = (project.project?.fileCandidates ?? []).slice(0, 120);
      const fileChoices = Object.fromEntries([["none", "No clearly relevant file in the list."], ...candidates.map((path, index) => [`f${index}`, path])]);
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
            instructions: TASK_PRECISION_INSTRUCTIONS
          },
          decomposition: {
            type: "score",
            criteria: TASK_DECOMPOSITION_CRITERIA,
            instructions: "Assess whether this single ticket is sufficiently split for one Codex task. A high score means one coherent deliverable; a low score suggests dividing independent outcomes into separate tickets. Do not penalize technical difficulty, number of files, or necessary implementation steps. Advisory only; never block execution."
          },
          primaryFile: {
            type: "choice",
            criteria: fileChoices,
            instructions: "Choose the most likely source, test, style, or configuration file Codex should inspect first for this task. Pick none if no candidate is credible. Prefer a concrete implementation file over general project documentation."
          },
          secondaryFile: {
            type: "choice",
            criteria: fileChoices,
            instructions: "Choose a second distinct file only when it is directly relevant to implementing this task. Otherwise choose none. Avoid unrelated files and project-wide reading."
          }
        }
      });
      const chosen = [result.answers.primaryFile.choice, result.answers.secondaryFile.choice]
        .map(key => /^f\d+$/.test(key) ? candidates[Number(key.slice(1))] : undefined)
        .filter((path): path is string => Boolean(path));
      return {
        taskType: result.answers.taskType.choice,
        complexity: result.answers.complexity.choice,
        taskPrecision: taskPrecisionPercentage(result.answers.taskPrecision.score),
        decompositionScore: taskDecompositionPercentage(result.answers.decomposition.score),
        relevantFiles: [...new Set(chosen)],
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
            instructions: TASK_PRECISION_INSTRUCTIONS
          }
        }
      });
      return {
        score: taskPrecisionPercentage(result.answers.precision.score),
        usage: result.usage
      };
    },
    async evaluateVerification(state) {
      const result = await evaluate({
        model,
        state,
        questions: {
          runAffectedTests: {
            type: "choice",
            criteria: {
              yes: "The actual added, changed, or deleted files have relevant existing tests in the provided candidate list. Run only those tests.",
              no: "The changes are documentation-only, or no listed test can meaningfully check the changed behavior. Do not run tests."
            },
            instructions: "Decide whether Codex should run targeted tests for the current ticket. Use only the changed files and candidate tests in the state. Never request a full test suite, a broad build, or dependency installation. Prefer yes for changed code with a directly related test."
          }
        }
      });
      return result.answers.runAffectedTests.choice === "yes";
    }
  };
}

/** Performs this backend operation. */
export function createConfiguredJevProvider(config: AppConfig): JevProvider {
  if (config.jevProvider === "vercel-ai-gateway") return createVercelGatewayJevProvider(config);
  throw new Error(`Unknown JEV provider "${config.jevProvider}". Add its adapter in src/core/jev-provider.ts.`);
}
