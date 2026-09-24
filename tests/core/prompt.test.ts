import { describe, expect, it } from "vitest";
import { buildCodexPrompt } from "../../src/core/prompt.js";
import type { JevAnalysis } from "../../src/core/types.js";

const analysis: JevAnalysis = {
  complexity: 1,
  task_types: ["feature"],
  model: "luna",
  reasoning: "low",
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

  it("lets Codex inspect the project files needed for the task", () => {
    const prompt = buildCodexPrompt([{ description: "Adjust a button" }], analysis);
    expect(prompt).toContain("inspect the project files needed to understand and complete the task");
    expect(prompt).toContain("Search the repository when useful");
    expect(prompt).not.toContain("JEV-selected files");
  });
});
