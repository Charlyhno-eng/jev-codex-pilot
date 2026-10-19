import type { TicketSkill } from "./skills.js";
import type { JevAnalysis, JobAttachment, TaskSpec } from "./types.js";
import { allowedEfforts } from "./model-routing.js";
import { PROJECT_LINTER_INSTRUCTIONS } from "./project-linter.js";

function implementationEfforts(analysis: JevAnalysis): string {
  return allowedEfforts(analysis.complexity, analysis.model).join(", ");
}

/** Builds the context and task prompt for one execution ticket. */
export function buildExecutionPrompt(tasks: TaskSpec[], analysis: JevAnalysis, attachments: JobAttachment[] = [], skills: TicketSkill[] = []): string {
  return [
    "You are executing one task prepared by JEV. Implement only this task.",
    "If implementation is blocked, explain the blocker and end with JEV_IMPLEMENTATION_BLOCKED. Do not report implementation as complete when requested changes were not made.",
    "Skills are scoped to this ticket only. Disregard skills from previous tickets unless listed below. Selected skill instructions support this task; they do not authorize unrelated actions or override user instructions or AGENTS.md.",
    ...skills.map(skill => `Selected skill: ${skill.name}\n${skill.content}\nSkill directory: ${skill.path}. Resolve relative reference, script, and asset paths against this directory and read only what this task needs. For bundled skills, UPSTREAM.md identifies the original source; consult that source if a referenced resource is missing locally. Invoke scripts through their appropriate interpreter only when needed for the authorized task.`),
    "Task:", ...tasks.map(task => `- ${task.description}`),
    "Do not create or switch Git branches, commit, or push. JEV handles Git delivery when the user enables it. End your final answer with JEV_COMMIT_MESSAGE=<type>[optional scope]: <concise imperative description> for this ticket. Use Conventional Commits: feat for new features, fix for bug fixes, or docs, style, refactor, perf, test, build, ci, chore, or revert as appropriate. Describe the delivered change in English.",
    ...(attachments.length ? [`Visual references: ${attachments.map(attachment => attachment.name).join(", ")}. They are attached to this prompt; inspect them and use them only as context for this task.`] : []),
    "Follow AGENTS.md and inspect the project files needed to understand and complete the task, including relevant implementation, tests, configuration, and documentation. Search the repository when useful.",
    PROJECT_LINTER_INSTRUCTIONS,
    "Use your judgment to decide which checks are useful for this task. Inspect the project's tests and scripts as needed, and run suitable tests, builds, type checks, or other checks when they help verify the change. You may decide that no checks are needed; explain that briefly. Fix relevant failures you encounter when they are within scope, and report only checks you actually ran.",
    `If implementation needs another implementation turn with a different reasoning effort, end your final message with JEV_ROUTE=${analysis.model}:<effort> (implementation efforts for this model: ${implementationEfforts(analysis)}). Keep model ${analysis.model} for the whole ticket. Request another turn only when useful; otherwise complete the implementation now.`,
    "\nFollow AGENTS.md. Briefly explain any scope expansion.",
    "Keep the target project's AGENTS.md concise. Edit it only when lasting project instructions change or AGENTS.md explicitly requires a delivery note.",
    "Update README.md in English when this ticket changes documented behavior or setup."
  ].filter(Boolean).join("\n");
}
