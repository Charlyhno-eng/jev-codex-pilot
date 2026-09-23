/** Published input rate used for local JEV cost estimates. */
export const JEV_INPUT_USD_PER_MILLION_TOKENS = 0.04;

/** Estimates the JEV input cost from token usage. */
export function estimateJevInputCost(inputTokens: number): number {
  return inputTokens / 1_000_000 * JEV_INPUT_USD_PER_MILLION_TOKENS;
}
