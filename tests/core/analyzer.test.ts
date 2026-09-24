import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../../src/core/analyzer.js";

describe("JEV model policy", () => {
  it("uses the lowest complexity route for installation work", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-install-"));
    writeFileSync(join(root, "AGENTS.md"), "Project rules");
    writeFileSync(join(root, "package.json"), "{}");
    const result = await analyze(root, [{ description: "Install the libraries required for the game" }], async () => ({ taskType: "installation", complexity: 1 }));
    expect(result.model).toBe("luna");
    expect(result.reasoning).toBe("medium");
  });

  it("keeps outcome clarity and complexity independently of model selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-breakdown-"));
    const result = await analyze(root, [{ description: "Implement a standalone feature" }], async () => ({ taskType: "feature", complexity: 1, outcomeClarityScore: 90 }));
    expect(result.complexity).toBe(1);
    expect(result.outcome_clarity_score).toBe(90);
    expect(result.model).toBe("luna");
  });

  it("uses Sol High for level-four UI and UX work", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-ui-"));
    writeFileSync(join(root, "AGENTS.md"), "Build a browser game");
    const result = await analyze(root, [{ description: "Create a polished laboratory interface with animated flames" }], async () => ({ taskType: "ui_ux", complexity: 4 }));
    expect(result.model).toBe("sol");
    expect(result.reasoning).toBe("high");
  });

  it("uses Luna medium for a low-complexity UI adjustment", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-small-ui-"));
    const result = await analyze(root, [{ description: "Move two small buttons" }], async () => ({ taskType: "ui_ux", complexity: 1 }));
    expect(result.model).toBe("luna");
    expect(result.reasoning).toBe("medium");
  });

  it("uses Luna High for level-two UI work", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-medium-ui-"));
    const result = await analyze(root, [{ description: "Redesign the settings panel" }], async () => ({ taskType: "ui_ux", complexity: 2 }));
    expect(result.model).toBe("luna");
    expect(result.reasoning).toBe("high");
  });

  it("uses Luna medium for clearly defined routine development", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-routine-"));
    const result = await analyze(root, [{ description: "Add a small API endpoint" }], async () => ({ taskType: "feature", complexity: 1 }));
    expect(result.model).toBe("luna");
    expect(result.reasoning).toBe("medium");
  });

  it("uses Luna High for level-two debugging", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-debug-"));
    const result = await analyze(root, [{ description: "Investigate an intermittent state bug" }], async () => ({ taskType: "bugfix", complexity: 2 }));
    expect(result.model).toBe("luna");
    expect(result.reasoning).toBe("high");
  });

  it("uses the configured Sol route for exceptional high-risk work", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-critical-"));
    const result = await analyze(root, [{ description: "Audit the critical distributed security architecture" }], async () => ({ taskType: "security", complexity: 5 }));
    expect(result.model).toBe("sol");
    expect(result.reasoning).toBe("xhigh");
  });

  it("uses JEV's decision and recommends Sol for level-four architecture", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-policy-"));
    writeFileSync(join(root, "main.ts"), "export {};");
    const result = await analyze(root, [{ description: "Redesign the application architecture" }], async () => ({ taskType: "architecture", complexity: 4, usage: { totalTokens: 42 } }));
    expect(result.task_types).toEqual(["architecture"]);
    expect(result.model).toBe("sol");
    expect(result.evaluator).toBe("typesafe-ai/jev");
    expect(result.evaluation_usage?.total_tokens).toBe(42);
    expect(result.evaluation_usage?.estimated_cost_usd).toBe(0.00000168);
  });

  it("does not select project files during task analysis", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-files-"));
    writeFileSync(join(root, "AGENTS.md"), "Project rules");
    writeFileSync(join(root, "orchestrator.ts"), "export {};");
    writeFileSync(join(root, "unrelated.ts"), "export {};");
    const state = await analyze(root, [{ description: "Fix repeated verification" }], async input => {
      expect(JSON.parse(input).project).toEqual({ agents: "Project rules" });
      return { taskType: "bugfix", complexity: 2 };
    });
    expect(state).not.toHaveProperty("context_files");
    expect(state).not.toHaveProperty("files_to_modify");
  });

});
