import type { JevAnalysis, Job, JobAttachment, TaskSpec } from "./types.js";
import { codexModelId, MODEL_LEVELS, REASONING_LEVELS } from "./codex-models.js";

function section(title: string, values: string[]) { return values.length ? `\n${title}:\n${values.map(x => `- ${x}`).join("\n")}` : ""; }

/** Performs this backend operation. */
export function buildCodexPrompt(tasks: TaskSpec[], analysis: JevAnalysis, attachments: JobAttachment[] = []): string {
  return [
    "You are executing one task prepared by JEV. Implement only this task.",
    "Task:", ...tasks.map(task => `- ${task.description}`),
    ...(attachments.length ? [`Visual references: ${attachments.map(attachment => attachment.name).join(", ")}. They are attached to this prompt; inspect them and use them only as context for this task.`] : []),
    section("JEV-selected files to inspect first", analysis.context_files),
    section("JEV-selected files likely to change", analysis.files_to_modify),
    "Start with AGENTS.md and the selected implementation files. Read README.md when updating it. Read another file only when a direct import, dependency, or concrete task requirement points to it. Avoid repository-wide reads and searches.",
    "Choose the implementation and exact files yourself from the project architecture.",
    "Focus this turn on implementation. Ask JEV to decide on tests by ending the turn; do not run tests or builds during implementation. JEV will supply the exact targeted verification command when needed.",
    `If implementation needs another Codex turn with a different model or reasoning effort, end your final message with JEV_ROUTE=<model>:<effort> (models: ${MODEL_LEVELS.join(", ")}; efforts: ${REASONING_LEVELS.join(", ")}). Request this only when useful, and leave the remaining work for that next turn. Otherwise complete the implementation in this turn.`,
    "\nFollow AGENTS.md. Briefly explain any scope expansion.",
    "Before finishing, update the target project's root AGENTS.md and README.md in English.",
    "AGENTS.md is mandatory: append exactly one concise English delivery-log bullet for this ticket under 'JEV Codex Pilot delivery log'. Create that section if it is missing.",
    "README.md is mandatory: update it to accurately reflect the current project. If it is missing, create a concise English README.md."
  ].filter(Boolean).join("\n");
}

/**
 * JEV decisions remain per job. This only combines the implementation prompts
 * for a small compatible execution group.
 */
/** Performs this backend operation. */
export function buildCodexGroupPrompt(jobs: Array<Pick<Job, "tasks" | "analysis" | "attachments">>): string {
  return [
    "You are executing a small compatible group of tasks prepared independently by JEV.",
    "Complete every numbered task below. Do not merge their scope or skip a task.",
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
    "Start with AGENTS.md and the selected implementation files. Read README.md when updating it. Read another file only when a direct import, dependency, or concrete task requirement points to it. Avoid repository-wide reads and searches.",
    "Choose the implementation and exact files from the project architecture.",
    "Focus this turn on implementation. Ask JEV to decide on tests by ending the turn; do not run tests or builds during implementation. JEV will supply the exact targeted verification command when needed.",
    `If implementation needs another Codex turn with a different model or reasoning effort, end your final message with JEV_ROUTE=<model>:<effort> (models: ${MODEL_LEVELS.join(", ")}; efforts: ${REASONING_LEVELS.join(", ")}). Request this only when useful, and leave the remaining work for that next turn. Otherwise complete the implementation in this turn.`,
    "Follow AGENTS.md. Briefly explain any scope expansion.",
    "Before finishing, update the target project's root AGENTS.md and README.md in English.",
    "AGENTS.md is mandatory: append exactly one concise English delivery-log bullet for each numbered ticket under 'JEV Codex Pilot delivery log'. Create that section if it is missing.",
    "README.md is mandatory: update it to accurately reflect the current project. If it is missing, create a concise English README.md."
  ].join("\n");
}

/** Performs this backend operation. */
export function buildCodexCommand(tasks: TaskSpec[], analysis: JevAnalysis, modelId = codexModelId(analysis.model)): string {
  const escaped = buildCodexPrompt(tasks, analysis).replace(/'/g, "'\\''");
  return `codex exec --json --color never --skip-git-repo-check --approve-for-me --model ${modelId} -c 'model_reasoning_effort="${analysis.reasoning}"' '${escaped}'`;
}
