import { experimental_evaluate as evaluate } from "ai";
import type { AppConfig } from "./app-config.js";
import { JEV_INPUT_USD_PER_MILLION_TOKENS } from "./jev-pricing.js";
import type { Complexity, TaskType } from "./types.js";
import { createVercelJevModel, VERCEL_AI_GATEWAY_EVALUATOR_ID, VERCEL_AI_GATEWAY_PROVIDER_ID } from "./vercel-ai-gateway.js";

export type JevDecision = {
  taskType: TaskType;
  complexity: Complexity;
  outcomeClarityScore?: number;
  relevantFiles?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

export type JevProvider = {
  id: string;
  inputUsdPerMillionTokens: number;
  evaluate(state: string): Promise<JevDecision>;
  evaluateVerification(state: string): Promise<boolean>;
  evaluateContinuity(state: string): Promise<"related" | "unrelated" | "uncertain">;
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

export const COMPLEXITY_CRITERIA = [
  "0 — Documentation, running tests, installation commands, or similarly mechanical work.",
  "1 — Simple or semi-structured work: small refactor, small feature, technical Q&A, short script, or extraction.",
  "2 — Medium feature, standard debugging, limited multi-file work, or simple business workflow.",
  "3 — Complex multi-step feature, non-trivial refactor, standard agentic coding, or multi-tool workflow.",
  "4 — Difficult or long task: architecture, hard debugging, long-horizon coding, or serious computer use.",
  "5 — Frontier or critical task: major architecture, security, science, very long horizon, or demanding computer use."
] as const;

export const OUTCOME_CLARITY_CRITERIA = [
  "0% — the expected result cannot be identified.",
  "10% — the ticket names a vague topic without describing a result.",
  "20% — the intended change is highly ambiguous.",
  "30% — a broad goal is recognizable, but the expected behavior is unclear.",
  "40% — the outcome is partly described, with major choices still open.",
  "50% — the general result is clear, but an important behavior remains ambiguous.",
  "60% — the expected change is actionable with some assumptions.",
  "70% — the result is clear; a few routine details can be inferred.",
  "80% — a concrete expected result and its boundaries are clear.",
  "100% — the expected result, boundaries, and success conditions are explicit."
] as const;

const SCORE_PERCENTAGES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 100] as const;
export function scorePercentage(level: number) { return SCORE_PERCENTAGES[Math.max(0, Math.min(SCORE_PERCENTAGES.length - 1, Math.round(level)))]!; }

/** Performs this backend operation. */
export function createVercelGatewayJevProvider(config: AppConfig): JevProvider {
  const model = createVercelJevModel(config.aiGatewayApiKey);
  return {
    id: VERCEL_AI_GATEWAY_EVALUATOR_ID,
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
            type: "score",
            criteria: COMPLEXITY_CRITERIA,
            instructions: "Score this task alone from 0 to 5. Judge the actual reasoning and implementation difficulty, not repository size, language, or other queued tasks. Use 0 for documentation, running tests, and installation commands; 1 for clearly bounded routine changes."
          },
          outcomeClarity: {
            type: "score",
            criteria: OUTCOME_CLARITY_CRITERIA,
            instructions: "Score how clearly this ticket describes the expected result, using its project AGENTS.md context. Judge the outcome and observable behavior, not how many implementation details or file names are specified. This is advisory only."
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
        complexity: Math.max(0, Math.min(5, Math.round(result.answers.complexity.score))) as Complexity,
        outcomeClarityScore: scorePercentage(result.answers.outcomeClarity.score),
        relevantFiles: [...new Set(chosen)],
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
    },
    async evaluateContinuity(state) {
      const result = await evaluate({
        model,
        state,
        questions: {
          continuity: {
            type: "choice",
            criteria: {
              related: "The next task continues the completed feature, fixes its outcome, or needs decisions and implementation context from it.",
              unrelated: "The next task is independent and can start from the project files and instructions without the completed task's conversation.",
              uncertain: "The task descriptions and likely files do not establish whether the prior conversation will help."
            },
            instructions: "Compare only the completed task and the next pending task in this project. Shared repository, common documentation, or a broad category alone does not make tasks related. Choose unrelated only when independence is clear; otherwise choose uncertain."
          }
        }
      });
      return result.answers.continuity.choice;
    }
  };
}

/** Performs this backend operation. */
export function createConfiguredJevProvider(config: AppConfig): JevProvider {
  if (config.jevProvider === VERCEL_AI_GATEWAY_PROVIDER_ID) return createVercelGatewayJevProvider(config);
  throw new Error(`Unknown JEV provider "${config.jevProvider}". Add its adapter in src/core/jev-provider.ts.`);
}
