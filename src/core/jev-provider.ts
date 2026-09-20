import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate } from "ai";
import type { AppConfig } from "./app-config.js";
import { JEV_INPUT_USD_PER_MILLION_TOKENS } from "./jev-pricing.js";
import type { Complexity, TaskType } from "./types.js";

export type JevDecision = {
  taskType: TaskType;
  complexity: Complexity;
  complexityScore: number;
  taskPrecision?: number;
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

const COMPLEXITY_CRITERIA = [
  "1/10 — rename a variable, correct a typo, change a constant, or make one obvious text edit",
  "2/10 — move or resize a small UI element, make a tiny CSS adjustment, or add one simple field",
  "3/10 — a small, localized and clearly specified change in one well-understood area",
  "4/10 — a routine function, component, endpoint, script, unit test, or bounded bug fix",
  "5/10 — a normal feature requiring several coordinated implementation decisions",
  "6/10 — multi-file application work with a few interactions, tests, or an API integration",
  "7/10 — difficult debugging, a broad feature, or a change with meaningful technical uncertainty",
  "8/10 — a major multi-service feature, migration, or substantial refactoring",
  "9/10 — a very difficult project-wide change, critical review, or architectural migration",
  "10/10 — exceptional ambiguity, risk, distributed behavior, security sensitivity, or deep cross-system reasoning"
] as const;

export const TASK_PRECISION_CRITERIA = [
  "0% — no actionable outcome, scope, or useful relation to the project context.",
  "10% — a vague request with almost no implementation detail.",
  "20% — an outcome is hinted at, but the intended behavior is unclear.",
  "35% — a concrete intent is present, with several important ambiguities remaining.",
  "45% — the main outcome is understandable, but key constraints or acceptance expectations are absent.",
  "55% — the task is workable, though Codex would need to make notable assumptions.",
  "65% — the outcome and relevant context are almost clear enough for normal implementation.",
  "75% — the task is specific, scoped, and well aligned with the project context.",
  "90% — the task has clear behavior, boundaries, and useful acceptance expectations.",
  "100% — the requested outcome, scope, constraints, and success criteria are unambiguous in context."
] as const;

const TASK_PRECISION_PERCENTAGES = [0, 10, 20, 35, 45, 55, 65, 75, 90, 100] as const;
export function taskPrecisionPercentage(level: number) { return TASK_PRECISION_PERCENTAGES[Math.max(0, Math.min(TASK_PRECISION_PERCENTAGES.length - 1, Math.round(level)))]!; }

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
          complexityScore: {
            type: "score",
            criteria: COMPLEXITY_CRITERIA,
            instructions: "Give this task a whole-number complexity level from 1 to 10. Use 1–3 for obvious localized changes such as a typo, a constant, a simple field, or repositioning a few buttons. Return 10 only for exceptional project-wide risk or ambiguity."
          },
          taskPrecision: {
            type: "score",
            criteria: TASK_PRECISION_CRITERIA,
            instructions: "Score how precisely this single task is stated for Codex in the supplied AGENTS.md project context. Judge clarity of the requested outcome, boundaries, expected behavior, and relevant constraints. Do not lower the score merely because implementation will be difficult. A score below 70 means Codex would benefit from a clearer task description; this is advisory only."
          }
        }
      });
      return {
        taskType: result.answers.taskType.choice,
        complexity: result.answers.complexity.choice,
        complexityScore: Math.max(1, Math.min(10, Math.round(result.answers.complexityScore.score) + 1)),
        taskPrecision: taskPrecisionPercentage(result.answers.taskPrecision.score),
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
            instructions: "Score how precisely this single task is stated for Codex in the supplied AGENTS.md project context. Judge clarity of the requested outcome, boundaries, expected behavior, and relevant constraints. Do not lower the score merely because implementation will be difficult. A score below 70 means Codex would benefit from a clearer task description; this is advisory only."
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

export function createConfiguredJevProvider(config: AppConfig): JevProvider {
  if (config.jevProvider === "vercel-ai-gateway") return createVercelGatewayJevProvider(config);
  throw new Error(`Unknown JEV provider "${config.jevProvider}". Add its adapter in src/core/jev-provider.ts.`);
}
