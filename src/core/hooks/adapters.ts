import { createJevHookClient } from "./jev-client.js";
import { gateShell, preToolUseOutput } from "./shell-gate.js";
import { postToolUse, preCompact } from "./context-diet.js";
import type { HookEvent } from "./types.js";
import { logJevError } from "../jev-logger.js";

/** Maps native Codex hook input to the three supported JEV actions. */
export async function handleCodexHook(event: HookEvent): Promise<object> {
  try {
    const client = createJevHookClient();
    if (event.hook_event_name === "PreToolUse" && event.tool_name === "Bash") return preToolUseOutput(await gateShell(event, client));
    if (event.hook_event_name === "PostToolUse") return postToolUse(event, client);
    if (event.hook_event_name === "PreCompact") return preCompact(event, client);
  } catch {
    // Fail open: malformed input, missing configuration, and provider errors never block Codex.
    if (event.hook_event_name === "PreToolUse" && event.tool_name === "Bash") logJevError("PreToolUse shell gate · allow · JEV unavailable (fail open)");
    if (event.hook_event_name === "PostToolUse") logJevError("PostToolUse context diet · fail open (JEV unavailable)");
    if (event.hook_event_name === "PreCompact") logJevError("PreCompact context diet · fail open (JEV unavailable)");
  }
  return {};
}
