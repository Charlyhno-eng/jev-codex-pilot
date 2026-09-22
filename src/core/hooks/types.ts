export type NoulQuestion = { kind: "Noul"; id: string; criteria: string; instructions?: string };
export type ChoiceQuestion = { kind: "Choice"; id: string; criteria: Record<string, string>; instructions?: string };
export type ScoreQuestion = { kind: "Score"; id: string; criteria: string[]; instructions?: string };
export type PureQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type PureAnswer =
  | { kind: "Noul"; value: boolean; probabilities: { true: number; false: number }; confidence: number }
  | { kind: "Choice"; value: string; probabilities: Record<string, number>; confidence: number }
  | { kind: "Score"; value: number; probabilities: Record<string, number>; confidence: number };

export type Escalation = { kind: "escalation"; reason: "text_or_code" | "low_confidence" | "jev_unavailable" | "invalid_answer"; questionId: string; confidence?: number };
export type OffloadResult = { kind: "jev"; answer: PureAnswer } | Escalation;

export type HookEvent = {
  hook_event_name: "PreToolUse" | "PostToolUse" | "PreCompact";
  session_id?: string;
  turn_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  cwd?: string;
  transcript_path?: string | null;
  tool_input?: unknown;
  tool_response?: unknown;
  trigger?: "manual" | "auto";
};
