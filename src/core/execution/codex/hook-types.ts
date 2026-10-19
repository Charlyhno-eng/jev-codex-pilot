/** Native Codex hook input, kept outside the provider-independent execution contract. */
export type HookEvent = {
  hook_event_name: "PreToolUse" | "PostToolUse" | "PreCompact" | "SessionStart";
  session_id?: string;
  turn_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  cwd?: string;
  transcript_path?: string | null;
  tool_input?: unknown;
  tool_response?: unknown;
  trigger?: "manual" | "auto";
  source?: "startup" | "resume" | "clear" | "compact";
};
