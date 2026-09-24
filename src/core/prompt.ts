import type { JevAnalysis, JobAttachment, TaskSpec } from "./types.js";
import { allowedEfforts, codexModelId } from "./codex-models.js";
import { codexExecPrefix } from "./codex-execution.js";

function implementationEfforts(analysis: JevAnalysis): string {
  return allowedEfforts(analysis.complexity, analysis.model).join(", ");
}

/** Builds the context and task prompt for one Codex ticket. */
export function buildCodexPrompt(tasks: TaskSpec[], analysis: JevAnalysis, attachments: JobAttachment[] = []): string {
  return [
    "You are executing one task prepared by JEV. Implement only this task.",
    "If implementation is blocked, explain the blocker and end with JEV_IMPLEMENTATION_BLOCKED. Do not report implementation as complete when requested changes were not made.",
    "Task:", ...tasks.map(task => `- ${task.description}`),
    ...(attachments.length ? [`Visual references: ${attachments.map(attachment => attachment.name).join(", ")}. They are attached to this prompt; inspect them and use them only as context for this task.`] : []),
    "Follow AGENTS.md and inspect the project files needed to understand and complete the task, including relevant implementation, tests, configuration, and documentation. Search the repository when useful.",
    "Use your judgment to decide which checks are useful for this task. Inspect the project's tests and scripts as needed, and run suitable tests, builds, type checks, or other checks when they help verify the change. You may decide that no checks are needed; explain that briefly. Fix relevant failures you encounter when they are within scope, and report only checks you actually ran.",
    `If implementation needs another Codex turn with a different reasoning effort, end your final message with JEV_ROUTE=${analysis.model}:<effort> (implementation efforts for this model: ${implementationEfforts(analysis)}). Keep model ${analysis.model} for the whole ticket. Request another turn only when useful; otherwise complete the implementation now.`,
    "\nFollow AGENTS.md. Briefly explain any scope expansion.",
    "Keep the target project's AGENTS.md concise. Edit it only when lasting project instructions change or AGENTS.md explicitly requires a delivery note.",
    "Update README.md in English when this ticket changes documented behavior or setup."
  ].filter(Boolean).join("\n");
}

/** Builds the displayed Codex command for a ticket. */
export function buildCodexCommand(tasks: TaskSpec[], analysis: JevAnalysis, modelId = codexModelId(analysis.model)): string {
  const escaped = buildCodexPrompt(tasks, analysis).replace(/'/g, "'\\''");
  return `codex ${codexExecPrefix().join(" ")} --json --skip-git-repo-check --model ${modelId} -c 'model_reasoning_effort="${analysis.reasoning}"' '${escaped}'`;
}
