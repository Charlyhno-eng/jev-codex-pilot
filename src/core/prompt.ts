import type { JevAnalysis, TaskSpec } from "./types.js";

function section(title: string, values: string[]) { return values.length ? `\n${title}:\n${values.map(x => `- ${x}`).join("\n")}` : ""; }

export function buildCodexPrompt(tasks: TaskSpec[], analysis: JevAnalysis): string {
  return [
    "You are executing one task prepared by JEV. Implement only this task.",
    "Task:", ...tasks.map(task => `- ${task.description}`),
    section("Relevant context (read only these files before expanding if necessary)", analysis.context_files),
    section("Known files likely to change", analysis.files_to_modify),
    "Choose the implementation and exact files yourself from the project architecture.",
    "\nFollow AGENTS.md. Briefly explain any scope expansion.",
    "If AGENTS.md contains the 'JEV Codex Pilot delivery log' section and this task implements a feature or change, append one concise bullet to that section before finishing."
  ].filter(Boolean).join("\n");
}

export function buildCodexCommand(tasks: TaskSpec[], analysis: JevAnalysis): string {
  const escaped = buildCodexPrompt(tasks, analysis).replace(/'/g, "'\\''");
  return `codex exec --json --color never --skip-git-repo-check --approve-for-me --model gpt-5.6-${analysis.model} -c 'model_reasoning_effort="${analysis.reasoning}"' '${escaped}'`;
}
