import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexQuotaWindows, readCodexContext } from "../../src/core/codex-status.js";

describe("Codex status snapshots", () => {
  it("reads the last context reading without exposing rollout content", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "jev-context-")), "rollout.jsonl");
    writeFileSync(path, [
      JSON.stringify({ payload: { type: "token_count", info: { last_token_usage: { input_tokens: 9_000 }, model_context_window: 128_000 } } }),
      JSON.stringify({ payload: { type: "agent_message", text: "private project data" } }),
      JSON.stringify({ payload: { type: "token_count", info: { last_token_usage: { input_tokens: 90_900 }, model_context_window: 258_000 } } })
    ].join("\n"));
    expect(await readCodexContext(path)).toEqual({ usedTokens: 90_900, windowTokens: 258_000 });
  });

  it("selects Codex's 5-hour and weekly limits from the account response", () => {
    const result = codexQuotaWindows({ rateLimitsByLimitId: { other: { primary: { usedPercent: 99, windowDurationMins: 300 } }, codex: { primary: { usedPercent: 19, windowDurationMins: 300, resetsAt: 1_780_000_000 }, secondary: { usedPercent: 71, windowDurationMins: 10_080, resetsAt: 1_780_000_100 } } } });
    expect(result.fiveHour).toMatchObject({ remainingPercent: 81, resetsAt: new Date(1_780_000_000_000).toISOString() });
    expect(result.weekly).toMatchObject({ remainingPercent: 29, resetsAt: new Date(1_780_000_100_000).toISOString() });
  });
});
