import { describe, expect, it } from "vitest";
import { TASK_DECOMPOSITION_CRITERIA, TASK_PRECISION_CRITERIA, taskDecompositionPercentage, taskPrecisionPercentage } from "../../src/core/jev-provider.js";

describe("JEV task precision scoring", () => {
  it("keeps the score question within TypeSafe JEV's ten-level limit", () => {
    expect(TASK_PRECISION_CRITERIA).toHaveLength(10);
    expect(TASK_DECOMPOSITION_CRITERIA).toHaveLength(10);
  });

  it("maps supported score levels to a visible percentage", () => {
    expect(Array.from({ length: 10 }, (_, level) => taskPrecisionPercentage(level))).toEqual([20, 20, 40, 60, 80, 80, 80, 80, 100, 100]);
    expect(taskPrecisionPercentage(9)).toBe(100);
    expect(taskDecompositionPercentage(7)).toBe(75);
  });
});
