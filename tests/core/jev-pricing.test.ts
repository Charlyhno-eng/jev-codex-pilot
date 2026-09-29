import { describe, expect, it } from "vitest";
import { estimateJevInputCost, JEV_INPUT_USD_PER_MILLION_TOKENS } from "../../src/core/jev-pricing.js";

describe("JEV input cost estimate", () => {
  it("scales token counts using the configured per-million rate", () => {
    expect(estimateJevInputCost(1_000_000)).toBe(JEV_INPUT_USD_PER_MILLION_TOKENS);
    expect(estimateJevInputCost(250_000)).toBe(0.01);
    expect(estimateJevInputCost(0)).toBe(0);
  });
});
