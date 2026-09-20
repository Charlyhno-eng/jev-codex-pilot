import { describe, expect, it } from "vitest";
import { TASK_PRECISION_CRITERIA, taskPrecisionPercentage } from "./jev-provider.js";

describe("JEV task precision scoring", () => {
  it("keeps the score question within TypeSafe JEV's ten-level limit", () => {
    expect(TASK_PRECISION_CRITERIA).toHaveLength(10);
  });

  it("maps supported score levels to a visible percentage", () => {
    expect(taskPrecisionPercentage(0)).toBe(0);
    expect(taskPrecisionPercentage(7)).toBe(75);
    expect(taskPrecisionPercentage(9)).toBe(100);
  });
});
