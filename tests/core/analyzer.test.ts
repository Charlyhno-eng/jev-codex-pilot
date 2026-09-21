import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, assessTaskPrecision } from "../../src/core/analyzer.js";

describe("JEV model policy", () => {
  it("uses Luna medium for a low-complexity installation task", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-install-"));
    writeFileSync(join(root, "AGENTS.md"), "Project rules");
    writeFileSync(join(root, "package.json"), "{}");
    const result = await analyze(root, [{ description: "Install the libraries required for the game" }], async () => ({ taskType: "installation", complexity: "low" }));
    expect(result.model).toBe("luna");
    expect(result.reasoning).toBe("medium");
    expect(result.files_to_modify).toContain("package.json");
  });

  it("preserves the advisory breakdown score independently of model selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-breakdown-"));
    const result = await analyze(root, [{ description: "Implement several unrelated features" }], async () => ({ taskType: "feature", complexity: "low", taskPrecision: 90, decompositionScore: 20 }));
    expect(result.decomposition_score).toBe(20);
    expect(result.precision_score).toBe(90);
    expect(result.model).toBe("luna");
  });

  it("always uses Sol medium when JEV classifies UI and UX work", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-ui-"));
    writeFileSync(join(root, "AGENTS.md"), "Build a browser game");
    const result = await analyze(root, [{ description: "Create a polished laboratory interface with animated flames" }], async () => ({ taskType: "ui_ux", complexity: "high" }));
    expect(result.model).toBe("sol");
    expect(result.reasoning).toBe("medium");
  });

  it("uses Luna medium for a low-complexity UI adjustment", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-small-ui-"));
    const result = await analyze(root, [{ description: "Move two small buttons" }], async () => ({ taskType: "ui_ux", complexity: "low" }));
    expect(result.model).toBe("luna");
    expect(result.reasoning).toBe("medium");
  });

  it("uses Terra medium for a normal UI task", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-medium-ui-"));
    const result = await analyze(root, [{ description: "Redesign the settings panel" }], async () => ({ taskType: "ui_ux", complexity: "medium" }));
    expect(result.model).toBe("terra");
    expect(result.reasoning).toBe("medium");
  });

  it("uses Luna medium for clearly defined routine development", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-routine-"));
    const result = await analyze(root, [{ description: "Add a small API endpoint" }], async () => ({ taskType: "feature", complexity: "low" }));
    expect(result.model).toBe("luna");
    expect(result.reasoning).toBe("medium");
  });

  it("raises reasoning before model size for difficult debugging", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-debug-"));
    const result = await analyze(root, [{ description: "Investigate an intermittent state bug" }], async () => ({ taskType: "bugfix", complexity: "medium" }));
    expect(result.model).toBe("terra");
    expect(result.reasoning).toBe("high");
  });

  it("uses Sol extra high for exceptional high-risk work", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-critical-"));
    const result = await analyze(root, [{ description: "Audit the critical distributed security architecture" }], async () => ({ taskType: "security", complexity: "very_high" }));
    expect(result.model).toBe("sol");
    expect(result.reasoning).toBe("xhigh");
  });

  it("uses JEV's decision and never recommends Astra", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-policy-"));
    writeFileSync(join(root, "main.ts"), "export {};");
    const result = await analyze(root, [{ description: "Redesign the application architecture" }], async () => ({ taskType: "architecture", complexity: "high", usage: { totalTokens: 42 } }));
    expect(result.task_types).toEqual(["architecture"]);
    expect(result.model).toBe("sol");
    expect(result.model).not.toBe("astra");
    expect(result.evaluator).toBe("typesafe-ai/jev");
    expect(result.evaluation_usage?.total_tokens).toBe(42);
    expect(result.evaluation_usage?.estimated_cost_usd).toBe(0.00000168);
  });

  it("always includes README.md in the context when the project has one", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-readme-"));
    writeFileSync(join(root, "AGENTS.md"), "Project rules");
    writeFileSync(join(root, "README.md"), "Project overview");
    const result = await analyze(root, [{ description: "Fix the game" }], async () => ({ taskType: "bugfix", complexity: "low" }));
    expect(result.context_files.slice(0, 2)).toEqual(["AGENTS.md", "README.md"]);
  });

  it("assesses draft-task precision against the project's AGENTS.md context", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-precision-"));
    writeFileSync(join(root, "AGENTS.md"), "This project is a browser game. Keep controls keyboard accessible.");
    let state = "";
    const result = await assessTaskPrecision(root, "Move the jump button below the score", async value => {
      state = value;
      return { score: 70, usage: { inputTokens: 18, totalTokens: 22 } };
    });

    expect(result.score).toBe(70);
    expect(state).toContain("browser game");
    expect(state).toContain("Move the jump button");
  });

  it("requires AGENTS.md for a draft-task precision check", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-precision-no-context-"));
    await expect(assessTaskPrecision(root, "Move a button", async () => ({ score: 80 }))).rejects.toThrow("AGENTS.md is required");
  });
});
