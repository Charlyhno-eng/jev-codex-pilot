import { experimental_evaluate as evaluate } from "ai";
import { AppConfigStore } from "../app-config.js";
import { recordJevUsage } from "../jev-usage.js";
import { createVercelJevModel, VERCEL_AI_GATEWAY_PROVIDER_ID } from "../vercel-ai-gateway.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PureAnswer, PureQuestion } from "./types.js";

export type JevHookClient = {
  evaluate(state: string, question: PureQuestion, signal: AbortSignal): Promise<PureAnswer>;
  evaluateBatch?(state: string, questions: PureQuestion[], signal: AbortSignal): Promise<Record<string, PureAnswer>>;
};

function probability(value: unknown): number {
  const number = typeof value === "number" ? value : NaN;
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : 0;
}

/** Evaluates one typed question with TypeSafe JEV and preserves answer probabilities. */
export function createJevHookClient(): JevHookClient {
  const config = new AppConfigStore(resolve(dirname(fileURLToPath(import.meta.url)), "../../../config/config.toml")).read();
  if (config.jevProvider !== VERCEL_AI_GATEWAY_PROVIDER_ID || !config.aiGatewayApiKey) throw new Error("JEV is unavailable");
  const model = createVercelJevModel(config.aiGatewayApiKey);
  return {
    async evaluate(state, question, signal) {
      if (question.kind === "Noul") {
        const result = await evaluate({ model, state, questions: { answer: { type: "boolean", criteria: { true: question.criteria, false: `Not true: ${question.criteria}` }, instructions: question.instructions ?? "Decide this yes/no question." } }, abortSignal: signal, maxRetries: 0 });
        recordJevUsage(result.usage);
        const trueProbability = probability(result.answers.answer.probability);
        const value = trueProbability >= 0.5;
        return { kind: "Noul", value, probabilities: { true: trueProbability, false: 1 - trueProbability }, confidence: value ? trueProbability : 1 - trueProbability };
      }
      if (question.kind === "Choice") {
        const result = await evaluate({ model, state, questions: { answer: { type: "choice", criteria: question.criteria, instructions: question.instructions ?? "Choose one option." } }, abortSignal: signal, maxRetries: 0 });
        recordJevUsage(result.usage);
        const answer = result.answers.answer;
        const probabilities = Object.fromEntries(Object.keys(question.criteria).map(key => [key, probability(answer.probabilities?.[key])]));
        return { kind: "Choice", value: answer.choice, probabilities, confidence: probabilities[answer.choice] ?? 0 };
      }
      const result = await evaluate({ model, state, questions: { answer: { type: "score", criteria: question.criteria, instructions: question.instructions ?? "Choose one score." } }, abortSignal: signal, maxRetries: 0 });
      recordJevUsage(result.usage);
      const answer = result.answers.answer;
      const probabilities = Object.fromEntries(Object.entries(answer.probabilities ?? {}).map(([key, value]) => [key, probability(value)]));
      return { kind: "Score", value: answer.score, probabilities, confidence: probabilities[String(answer.score)] ?? 0 };
    },
    async evaluateBatch(state, questions, signal) {
      const definitions = Object.fromEntries(questions.map(question => [question.id, question.kind === "Noul"
        ? { type: "boolean", criteria: { true: question.criteria, false: `Not true: ${question.criteria}` }, instructions: question.instructions ?? "Decide this yes/no question." }
        : question.kind === "Choice"
          ? { type: "choice", criteria: question.criteria, instructions: question.instructions ?? "Choose one option." }
          : { type: "score", criteria: question.criteria, instructions: question.instructions ?? "Choose one score." }])) as Record<string,
        | { type: "boolean"; criteria: { true: string; false: string }; instructions: string }
        | { type: "choice"; criteria: Record<string, string>; instructions: string }
        | { type: "score"; criteria: string[]; instructions: string }>;
      const result = await evaluate({ model, state, questions: definitions, abortSignal: signal, maxRetries: 0 });
      recordJevUsage(result.usage);
      const answers = result.answers as Record<string, { type: string; probability?: number; choice?: string; score?: number; probabilities?: Record<string, number> }>;
      return Object.fromEntries(questions.map(question => {
        const answer = answers[question.id];
        if (!answer) throw new Error("Missing JEV batch answer");
        if (question.kind === "Noul") {
          const p = probability(answer.probability);
          const value = p >= 0.5;
          return [question.id, { kind: "Noul", value, probabilities: { true: p, false: 1 - p }, confidence: value ? p : 1 - p }];
        }
        if (question.kind === "Choice") {
          const probabilities = Object.fromEntries(Object.keys(question.criteria).map(key => [key, probability(answer.probabilities?.[key])]));
          return [question.id, { kind: "Choice", value: answer.choice, probabilities, confidence: probabilities[answer.choice ?? ""] ?? 0 }];
        }
        const probabilities = Object.fromEntries(Object.entries(answer.probabilities ?? {}).map(([key, value]) => [key, probability(value)]));
        return [question.id, { kind: "Score", value: answer.score, probabilities, confidence: probabilities[String(answer.score)] ?? 0 }];
      })) as Record<string, PureAnswer>;
    }
  };
}
