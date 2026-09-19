import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate } from "ai";
import type { AppConfig } from "./app-config.js";
import { JEV_INPUT_USD_PER_MILLION_TOKENS } from "./jev-pricing.js";
import type { Complexity, TaskType } from "./types.js";

export type JevDecision = {
  taskType: TaskType;
  complexity: Complexity;
  complexityScore: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

export type JevProvider = {
  id: string;
  inputUsdPerMillionTokens: number;
  evaluate(state: string): Promise<JevDecision>;
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
  "1/10 — tiny deterministic change with negligible implementation judgment",
  "2/10 — very small bounded change",
  "3/10 — routine change in one well-understood area",
  "4/10 — bounded change with some implementation judgment",
  "5/10 — normal feature requiring several coordinated decisions",
  "6/10 — moderately broad change across related files",
  "7/10 — difficult change spanning important parts of the project",
  "8/10 — broad change with significant uncertainty or integration risk",
  "9/10 — very difficult project-wide change",
  "10/10 — exceptional scope, ambiguity, or technical risk"
] as const;

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
            instructions: "Estimate only this one task. Do not inflate complexity because other tasks may exist. Package installation by itself is low at most."
          },
          complexityScore: {
            type: "score",
            criteria: COMPLEXITY_CRITERIA,
            instructions: "Give this task a whole-number complexity level from 1 to 10. Return 1 for the smallest task and 10 for the most complex project-wide task."
          }
        }
      });
      return {
        taskType: result.answers.taskType.choice,
        complexity: result.answers.complexity.choice,
        complexityScore: Math.max(1, Math.min(10, Math.round(result.answers.complexityScore.score) + 1)),
        usage: result.usage
      };
    }
  };
}

export function createConfiguredJevProvider(config: AppConfig): JevProvider {
  if (config.jevProvider === "vercel-ai-gateway") return createVercelGatewayJevProvider(config);
  throw new Error(`Unknown JEV provider "${config.jevProvider}". Add its adapter in src/core/jev-provider.ts.`);
}
