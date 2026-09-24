import { describe, expect, it } from "vitest";
import { COMPLEXITY_CRITERIA, OUTCOME_CLARITY_CRITERIA, scorePercentage } from "../../src/core/jev-provider.js";

describe("JEV ticket scoring", () => {
  it("uses five complexity levels and stays within TypeSafe JEV's ten-level score limit", () => {
    expect(OUTCOME_CLARITY_CRITERIA).toHaveLength(10);
    expect(COMPLEXITY_CRITERIA).toHaveLength(5);
  });

  it("maps supported score levels to a visible percentage", () => {
    expect(Array.from({ length: 10 }, (_, level) => scorePercentage(level))).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 100]);
    expect(scorePercentage(9)).toBe(100);
  });
});
