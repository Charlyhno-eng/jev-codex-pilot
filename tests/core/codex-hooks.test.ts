import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { codexHookArgs } from "../../src/core/hooks/codex-config.js";
import { judgeDiet, postToolUse, smartTruncate } from "../../src/core/hooks/context-diet.js";
import type { JevHookClient } from "../../src/core/hooks/jev-client.js";
import { offloadDecision } from "../../src/core/hooks/offload.js";
import { gateShell, preToolUseOutput } from "../../src/core/hooks/shell-gate.js";

const client = (answers: Record<string, any>): JevHookClient => ({
  evaluate: vi.fn(async () => answers.answer),
  evaluateBatch: vi.fn(async () => answers)
});

describe("native Codex hooks", () => {
  it("offloads a pure boolean and escalates text or unavailable JEV", async () => {
    const question = { kind: "Noul" as const, id: "relevant", criteria: "Is this relevant?" };
    expect(await offloadDecision({ id: "relevant", state: "{}", output: "pure", question }, client({ answer: { kind: "Noul", value: true, probabilities: { true: .96, false: .04 }, confidence: .96 } }))).toMatchObject({ kind: "jev", answer: { value: true, confidence: .96 } });
    expect(await offloadDecision({ id: "text", state: "{}", output: "text", question }, client({}))).toMatchObject({ kind: "escalation", reason: "text_or_code" });
    const stalled: JevHookClient = { evaluate: () => new Promise(() => {}) };
    expect(await offloadDecision({ id: "relevant", state: "{}", output: "pure", question }, stalled, 5)).toMatchObject({ kind: "escalation", reason: "jev_unavailable" });
  });

  it("denies a confident dangerous shell command and fails open on uncertainty", async () => {
    const confident = client({
      in_scope: { kind: "Noul", value: false, probabilities: { true: .02, false: .98 }, confidence: .98 },
      risk: { kind: "Score", value: 4, probabilities: { "4": .97 }, confidence: .97 },
      shell_gate: { kind: "Choice", value: "deny", probabilities: { deny: .98 }, confidence: .98 }
    });
    const event = { hook_event_name: "PreToolUse" as const, tool_name: "Bash", cwd: "/project", tool_input: { command: "rm -rf important" } };
    expect(preToolUseOutput(await gateShell(event, confident))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    const uncertain = client({
      in_scope: { kind: "Noul", value: false, probabilities: { true: .02, false: .98 }, confidence: .98 },
      risk: { kind: "Score", value: 4, probabilities: { "4": .97 }, confidence: .97 },
      shell_gate: { kind: "Choice", value: "deny", probabilities: { deny: .4 }, confidence: .4 }
    });
    expect((await gateShell(event, uncertain)).action).toBe("allow");
  });

  it("keeps critical diagnostics even when JEV proposes dropping them", async () => {
    const decisions = await judgeDiet(["ERROR test failed at src/app.ts", "obsolete progress line"], client({
      item_0: { kind: "Choice", value: "drop", probabilities: { drop: .96 }, confidence: .96 },
      item_1: { kind: "Choice", value: "drop", probabilities: { drop: .97 }, confidence: .97 }
    }));
    expect(decisions.map(item => item.action)).toEqual(["keep", "drop"]);
    expect(smartTruncate("start\nERROR test failed\n" + "x".repeat(5000) + "\nend")).toContain("ERROR test failed");
    expect(await postToolUse({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "api_key=private " + "x".repeat(4000) }, client({}))).toEqual({});
    const compacted = await postToolUse({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "obsolete progress ".repeat(300) }, client(Object.fromEntries([0, 1, 2].map(index => [`item_${index}`, { kind: "Choice", value: "drop", probabilities: { drop: .99 }, confidence: .99 }]))));
    expect(compacted).toMatchObject({ continue: false, hookSpecificOutput: { hookEventName: "PostToolUse" } });
    const critical = await postToolUse({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "x".repeat(1_790) + "\nERROR test failed at src/app.ts\n" + "x".repeat(1_790) }, client(Object.fromEntries([0, 1, 2].map(index => [`item_${index}`, { kind: "Choice", value: "drop", probabilities: { drop: .99 }, confidence: .99 }]))));
    expect(JSON.stringify(critical)).toContain("ERROR test failed at src/app.ts");
  });

  it("passes all three native hook settings to Codex without a target-project file", () => {
    const args = codexHookArgs();
    expect(args.join(" ")).toContain("hooks.PreToolUse");
    expect(args.join(" ")).toContain("hooks.PostToolUse");
    expect(args.join(" ")).toContain("hooks.PreCompact");
    const check = spawnSync("codex", [...args, "features", "list"], { encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);
  });
});
