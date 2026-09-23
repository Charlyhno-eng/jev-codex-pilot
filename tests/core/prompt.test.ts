import { describe, expect, it } from "vitest";
import { buildCodexGroupPrompt, buildCodexPrompt } from "../../src/core/prompt.js";
import type { JevAnalysis } from "../../src/core/types.js";

const analysis: JevAnalysis = {
  complexity: 1,
  task_types: ["feature"],
  model: "luna",
  reasoning: "low",
  context_files: [],
  files_to_modify: [],
  rationale: [],
  evaluator: "typesafe-ai/jev"
};

describe("Codex completion documentation", () => {
  it("keeps AGENTS.md concise for an individual ticket", () => {
    const prompt = buildCodexPrompt([{ description: "Adjust a button" }], analysis);
    expect(prompt).toContain("Edit it only when lasting project instructions change or AGENTS.md explicitly requires a delivery note");
    expect(prompt).toContain("Update README.md in English when this ticket changes documented behavior or setup");
    expect(prompt).not.toContain("delivery-log bullet");
  });

  it("reuses only verified unchanged context in the same thread", () => {
    const prompt = buildCodexPrompt([{ description: "Adjust a button" }], { ...analysis, context_files: ["AGENTS.md", "src/button.ts"] }, [], ["AGENTS.md"]);
    expect(prompt).toContain("Files unchanged since earlier successful work in this Codex thread");
    expect(prompt).toContain("- AGENTS.md");
    expect(prompt).toContain("Read selected files absent from the unchanged list");
  });

  it("keeps AGENTS.md concise for grouped tickets", () => {
    const prompt = buildCodexGroupPrompt([
      { tasks: [{ description: "Adjust a button" }], analysis },
      { tasks: [{ description: "Update the color" }], analysis }
    ]);
    expect(prompt).toContain("Edit it only when lasting project instructions change or AGENTS.md explicitly requires a delivery note");
    expect(prompt).toContain("Update README.md in English when these tickets change documented behavior or setup");
  });
});
