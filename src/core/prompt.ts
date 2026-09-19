import type { JevAnalysis, Job, TaskSpec } from "./types.js";

function section(title: string, values: string[]) { return values.length ? `\n${title}:\n${values.map(x => `- ${x}`).join("\n")}` : ""; }

export function buildCodexPrompt(tasks: TaskSpec[], analysis: JevAnalysis): string {
  return [
    "You are executing one task prepared by JEV. Implement only this task.",
    "Task:", ...tasks.map(task => `- ${task.description}`),
    section("Relevant context (read only these files before expanding if necessary)", analysis.context_files),
    section("Known files likely to change", analysis.files_to_modify),
    "Choose the implementation and exact files yourself from the project architecture.",
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
export function buildCodexGroupPrompt(jobs: Array<Pick<Job, "tasks" | "analysis">>): string {
  return [
    "You are executing a small compatible group of tasks prepared independently by JEV.",
    "Complete every numbered task below. Do not merge their scope or skip a task.",
    "The shared prompt is an execution optimisation only; each task retains its own JEV analysis and history.",
    ...jobs.flatMap((job, index) => {
      const analysis = job.analysis!;
      return [
        `\nTask ${index + 1}:`,
        ...job.tasks.map(task => `- ${task.description}`),
        section(`Task ${index + 1} relevant context (read these files first)`, analysis.context_files),
        section(`Task ${index + 1} likely files to change`, analysis.files_to_modify)
      ].filter(Boolean);
    }),
    "Choose the implementation and exact files from the project architecture.",
    "Follow AGENTS.md. Briefly explain any scope expansion.",
    "Before finishing, update the target project's root AGENTS.md and README.md in English.",
    "AGENTS.md is mandatory: append exactly one concise English delivery-log bullet for each numbered ticket under 'JEV Codex Pilot delivery log'. Create that section if it is missing.",
    "README.md is mandatory: update it to accurately reflect the current project. If it is missing, create a concise English README.md."
  ].join("\n");
}

export function buildCodexCommand(tasks: TaskSpec[], analysis: JevAnalysis): string {
  const escaped = buildCodexPrompt(tasks, analysis).replace(/'/g, "'\\''");
  return `codex exec --json --color never --skip-git-repo-check --approve-for-me --model gpt-5.6-${analysis.model} -c 'model_reasoning_effort="${analysis.reasoning}"' '${escaped}'`;
}
