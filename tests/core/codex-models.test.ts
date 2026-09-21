import { afterEach, describe, expect, it } from "vitest";
import { codexModelId, MODEL_LEVELS, REASONING_LEVELS } from "../../src/core/codex-models.js";
import { selectCodexModelId } from "../../src/core/codex-catalog.js";

afterEach(() => { delete process.env.JEV_CODEX_MODEL_LUNA; });

describe("Codex model catalog", () => {
  it("keeps stable tiers and resolves renamed model IDs from configuration", () => {
    expect(MODEL_LEVELS).toEqual(["luna", "terra", "sol"]);
    expect(REASONING_LEVELS).toEqual(["low", "medium", "high", "xhigh"]);
    process.env.JEV_CODEX_MODEL_LUNA = "gpt-future-luna";
    expect(codexModelId("luna")).toBe("gpt-future-luna");
  });

  it("picks a renamed installed model when the old ID disappears", () => {
    const available = [{ model: "gpt-5.7-luna", displayName: "GPT-5.7 Luna" }, { model: "gpt-5.7-terra", displayName: "GPT-5.7 Terra" }];
    expect(selectCodexModelId("luna", available)).toBe("gpt-5.7-luna");
    expect(selectCodexModelId("sol", available)).toBe("gpt-5.6-sol");
  });
});
