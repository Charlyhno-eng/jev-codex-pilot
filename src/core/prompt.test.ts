import { describe, expect, it } from "vitest";
import { buildCodexGroupPrompt, buildCodexPrompt } from "./prompt.js";
import type { JevAnalysis } from "./types.js";

const analysis: JevAnalysis = {
  complexity: "low",
  task_types: ["feature"],
  model: "luna",
  reasoning: "low",
  context_files: [],
  files_to_modify: [],
  rationale: [],
  evaluator: "typesafe-ai/jev"
};

describe("Codex completion documentation", () => {
  it("requires AGENTS.md and README.md updates for every individual ticket", () => {
    const prompt = buildCodexPrompt([{ description: "Adjust a button" }], analysis);
    expect(prompt).toContain("root AGENTS.md and README.md in English");
    expect(prompt).toContain("append exactly one concise English delivery-log bullet");
    expect(prompt).toContain("If it is missing, create a concise English README.md");
  });

  it("requires one English delivery-log line per grouped ticket", () => {
    const prompt = buildCodexGroupPrompt([
      { tasks: [{ description: "Adjust a button" }], analysis },
      { tasks: [{ description: "Update the color" }], analysis }
    ]);
    expect(prompt).toContain("one concise English delivery-log bullet for each numbered ticket");
    expect(prompt).toContain("root AGENTS.md and README.md in English");
  });
});
