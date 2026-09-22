import type { JevHookClient } from "./jev-client.js";
import type { OffloadResult, PureQuestion } from "./types.js";
import { logJevError } from "../jev-logger.js";

export type DecisionRequest = { id: string; state: string; output: "pure" | "text" | "code"; question?: PureQuestion; minimumConfidence?: number };

/** Sends only bounded pure decisions to JEV and returns a typed LLM escalation otherwise. */
export async function offloadDecision(request: DecisionRequest, client: JevHookClient, timeoutMs = 1_200): Promise<OffloadResult> {
  if (request.output !== "pure" || !request.question) {
    logJevError(`Decision offload · ${request.id} · escalated to Codex (text or code required)`);
    return { kind: "escalation", reason: "text_or_code", questionId: request.id };
  }
  const controller = new AbortController();
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error("JEV timed out")); }, timeoutMs);
  try {
    const answer = await Promise.race([client.evaluate(request.state, request.question, controller.signal), timeout]);
    if (answer.kind !== request.question.kind || (answer.kind === "Choice" && (request.question.kind !== "Choice" || !(answer.value in request.question.criteria))) || (answer.kind === "Score" && (request.question.kind !== "Score" || !Number.isInteger(answer.value) || answer.value < 0 || answer.value >= request.question.criteria.length))) {
      logJevError(`Decision offload · ${request.id} · fail open (invalid JEV answer)`);
      return { kind: "escalation", reason: "invalid_answer", questionId: request.id };
    }
    if (answer.confidence < (request.minimumConfidence ?? 0.7)) {
      logJevError(`Decision offload · ${request.id} · escalated to Codex (confidence ${answer.confidence.toFixed(2)})`);
      return { kind: "escalation", reason: "low_confidence", questionId: request.id, confidence: answer.confidence };
    }
    logJevError(`Decision offload · ${request.id} · handled by JEV · confidence ${answer.confidence.toFixed(2)}`);
    return { kind: "jev", answer };
  } catch {
    logJevError(`Decision offload · ${request.id} · fail open (JEV unavailable)`);
    return { kind: "escalation", reason: "jev_unavailable", questionId: request.id };
  } finally {
    clearTimeout(timer);
  }
}

/** Offloads several pure questions in one provider call with a shared timeout. */
export async function offloadDecisions(state: string, questions: PureQuestion[], client: JevHookClient, minimumConfidence = 0.7, timeoutMs = 1_200): Promise<Record<string, OffloadResult>> {
  const escalate = (reason: "jev_unavailable" | "low_confidence" | "invalid_answer") => {
    logJevError(`Decision offload · ${questions.length} typed decisions · fail open (${reason})`);
    return Object.fromEntries(questions.map(question => [question.id, { kind: "escalation", reason, questionId: question.id }])) as Record<string, OffloadResult>;
  };
  if (!client.evaluateBatch) return escalate("jev_unavailable");
  const controller = new AbortController();
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error("JEV timed out")); }, timeoutMs);
  try {
    const answers = await Promise.race([client.evaluateBatch(state, questions, controller.signal), timeout]);
    const results = Object.fromEntries(questions.map(question => {
      const answer = answers[question.id];
      if (!answer || answer.kind !== question.kind || (answer.kind === "Choice" && (question.kind !== "Choice" || !(answer.value in question.criteria))) || (answer.kind === "Score" && (question.kind !== "Score" || !Number.isInteger(answer.value) || answer.value < 0 || answer.value >= question.criteria.length))) return [question.id, { kind: "escalation", reason: "invalid_answer", questionId: question.id }];
      if (answer.confidence < minimumConfidence) return [question.id, { kind: "escalation", reason: "low_confidence", questionId: question.id, confidence: answer.confidence }];
      return [question.id, { kind: "jev", answer }];
    })) as Record<string, OffloadResult>;
    const handled = Object.values(results).filter(result => result.kind === "jev").length;
    logJevError(`Decision offload · ${questions.length} typed decisions · ${handled} handled by JEV · ${questions.length - handled} escalated to Codex`);
    return results;
  } catch {
    return escalate("jev_unavailable");
  } finally {
    clearTimeout(timer);
  }
}
