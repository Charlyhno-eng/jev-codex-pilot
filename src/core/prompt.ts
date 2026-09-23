import type { JevAnalysis, Job, JobAttachment, TaskSpec } from "./types.js";
import { allowedEfforts, codexModelId } from "./codex-models.js";
import { codexExecPrefix } from "./codex-execution.js";

function section(title: string, values: string[]) { return values.length ? `\n${title}:\n${values.map(x => `- ${x}`).join("\n")}` : ""; }
function implementationEfforts(analysis: JevAnalysis): string {
  return allowedEfforts(analysis.complexity, analysis.model).join(", ");
}

/** Builds the context and task prompt for one Codex ticket. */
export function buildCodexPrompt(tasks: TaskSpec[], analysis: JevAnalysis, attachments: JobAttachment[] = [], reusableFiles: string[] = []): string {
  return [
    "You are executing one task prepared by JEV. Implement only this task.",
    "If implementation is blocked, explain the blocker and end with JEV_IMPLEMENTATION_BLOCKED. Do not report implementation as complete when requested changes were not made.",
    "Task:", ...tasks.map(task => `- ${task.description}`),
    ...(attachments.length ? [`Visual references: ${attachments.map(attachment => attachment.name).join(", ")}. They are attached to this prompt; inspect them and use them only as context for this task.`] : []),
    section("JEV-selected files to inspect first", analysis.context_files),
    section("JEV-selected files likely to change", analysis.files_to_modify),
    ...(reusableFiles.length ? [section("Files unchanged since earlier successful work in this Codex thread", reusableFiles)] : []),
    reusableFiles.length ? "Reuse existing thread context for unchanged files when sufficient. Read a listed file if the task needs exact text or it was not actually loaded before. Read selected files absent from the unchanged list, including AGENTS.md. Read README.md when updating it. Avoid repository-wide reads and searches." : "Start with AGENTS.md and the selected implementation files. Read README.md when updating it. Read another file only when a direct import, dependency, or concrete task requirement points to it. Avoid repository-wide reads and searches.",
    "Choose the implementation and exact files yourself from the project architecture.",
    "Focus this turn on implementation. Ask JEV to decide on tests by ending the turn; do not run tests or builds during implementation. JEV will supply the exact targeted verification command when needed.",
    `If implementation needs another Codex turn with a different reasoning effort, end your final message with JEV_ROUTE=${analysis.model}:<effort> (implementation efforts for this model: ${implementationEfforts(analysis)}). Keep model ${analysis.model} for the whole ticket to preserve cache reuse. Request another turn only when useful; otherwise complete the implementation now.`,
    `If implementation is complete and only documentation remains, request JEV_ROUTE=${analysis.model}:low and leave that documentation for the Low-effort continuation.`,
    "\nFollow AGENTS.md. Briefly explain any scope expansion.",
    "Keep the target project's AGENTS.md concise. Edit it only when lasting project instructions change or AGENTS.md explicitly requires a delivery note.",
    "Update README.md in English when this ticket changes documented behavior or setup."
  ].filter(Boolean).join("\n");
}

/**
 * JEV decisions remain per job. This only combines the implementation prompts
 * for a small compatible execution group.
 */
/** Builds a Codex prompt for a related ticket group. */
export function buildCodexGroupPrompt(jobs: Array<Pick<Job, "tasks" | "analysis" | "attachments">>, reusableFiles: string[] = []): string {
  const first = jobs[0];
  return [
    "You are executing a small compatible group of tasks prepared independently by JEV.",
    "Complete every numbered task below. Do not merge their scope or skip a task.",
    "If any implementation is blocked, explain the blocker and end with JEV_IMPLEMENTATION_BLOCKED. Do not report implementation as complete when requested changes were not made.",
    "The shared prompt is an execution optimisation only; each task retains its own JEV analysis and history.",
    ...jobs.flatMap((job, index) => {
      const analysis = job.analysis!;
      return [
        `\nTask ${index + 1}:`,
        ...job.tasks.map(task => `- ${task.description}`),
        ...(job.attachments?.length ? [`Task ${index + 1} visual references: ${job.attachments.map(attachment => attachment.name).join(", ")}. These images are attached to the shared prompt; use them only for this numbered task.`] : []),
        section(`Task ${index + 1} JEV-selected files to inspect first`, analysis.context_files),
        section(`Task ${index + 1} JEV-selected files likely to change`, analysis.files_to_modify)
      ].filter(Boolean);
    }),
    ...(reusableFiles.length ? [section("Files unchanged since earlier successful work in this Codex thread", reusableFiles)] : []),
    reusableFiles.length ? "Reuse existing thread context for unchanged files when sufficient. Read a listed file if the task needs exact text or it was not actually loaded before. Read selected files absent from the unchanged list, including AGENTS.md. Read README.md when updating it. Avoid repository-wide reads and searches." : "Start with AGENTS.md and the selected implementation files. Read README.md when updating it. Read another file only when a direct import, dependency, or concrete task requirement points to it. Avoid repository-wide reads and searches.",
    "Choose the implementation and exact files from the project architecture.",
    "Focus this turn on implementation. Ask JEV to decide on tests by ending the turn; do not run tests or builds during implementation. JEV will supply the exact targeted verification command when needed.",
    `If implementation needs another Codex turn with a different reasoning effort, end your final message with JEV_ROUTE=${first.analysis!.model}:<effort> (implementation efforts for this model: ${implementationEfforts(first.analysis!)}). Keep model ${first.analysis!.model} for the whole ticket group to preserve cache reuse. Request another turn only when useful; otherwise complete the implementation now.`,
    `If implementation is complete and only documentation remains, request JEV_ROUTE=${first.analysis!.model}:low and leave that documentation for the Low-effort continuation.`,
    "Follow AGENTS.md. Briefly explain any scope expansion.",
    "Keep the target project's AGENTS.md concise. Edit it only when lasting project instructions change or AGENTS.md explicitly requires a delivery note.",
    "Update README.md in English when these tickets change documented behavior or setup."
  ].join("\n");
}

/** Builds the displayed Codex command for a ticket. */
export function buildCodexCommand(tasks: TaskSpec[], analysis: JevAnalysis, modelId = codexModelId(analysis.model)): string {
  const escaped = buildCodexPrompt(tasks, analysis).replace(/'/g, "'\\''");
  return `codex ${codexExecPrefix().join(" ")} --json --skip-git-repo-check --model ${modelId} -c 'model_reasoning_effort="${analysis.reasoning}"' '${escaped}'`;
}
