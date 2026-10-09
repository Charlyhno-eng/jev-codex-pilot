import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillStore } from "../../src/core/skills.js";
import { JobQueue } from "../../src/core/queue.js";
import { Orchestrator } from "../../src/core/orchestrator.js";
import type { JevAnalysis } from "../../src/core/types.js";

const analysis: JevAnalysis = { complexity: 1, task_types: ["research"], model: "luna", reasoning: "medium", rationale: [], evaluator: "typesafe-ai/jev" };

describe("ticket-scoped skills at the Codex boundary", () => {
  it("passes frozen instructions on initial execution and resumed execution without leaking them into the next ticket", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-skill-execution-"));
    const originalPath = process.env.PATH, originalHome = process.env.CODEX_HOME;
    try {
      const bin = join(root, "bin"), project = join(root, "project"), calls = join(root, "calls.jsonl");
      mkdirSync(bin); mkdirSync(project);
      process.env.CODEX_HOME = join(root, "codex-home");
      const fake = join(bin, "codex");
      writeFileSync(fake, `#!/bin/sh
if [ "$1" != exec ]; then exit 0; fi
printf '%s\\n' CALL_START "$@" >> '${calls}'
printf '%s\\n' '{"type":"thread.started","thread_id":"skill-test-thread"}' '{"type":"turn.completed"}'
`);
      chmodSync(fake, 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      const queue = new JobQueue(join(root, "data"));
      const store = new SkillStore(join(root, "data"));
      const skill = store.list().find(item => item.name === "frontend-design")!;
      const [first, next] = queue.createBatch("project", project, [{ description: "Read UI implementation" }, { description: "Read README" }]);
      const frozen = store.freeze(first.id, store.select([skill.id]));
      queue.update(first.id, { analysis, skills: frozen }); queue.update(next.id, { analysis });
      const orchestrator = new Orchestrator(queue, async () => analysis, async () => undefined, async () => ({ capturedAt: new Date().toISOString() }), async () => undefined, async () => ({ available: false, reached: false }), async () => ({ capturedAt: new Date().toISOString() }), async () => "related");
      await orchestrator.runBatch(first.id);
      expect(queue.get(first.id)?.status).toBe("SUCCESS"); expect(queue.get(next.id)?.status).toBe("SUCCESS");
      let invocations = readFileSync(calls, "utf8").split("CALL_START\n").slice(1);
      expect(invocations).toHaveLength(2);
      const firstPrompt = invocations[0];
      expect(firstPrompt).toContain(frozen[0].content); expect(firstPrompt).toContain(frozen[0].path);
      expect(queue.get(first.id)?.execution?.threadId).toBe("skill-test-thread");
      expect(invocations[1]).toContain("resume");
      expect(invocations[1]).not.toContain("frontend-design");
      expect(invocations[1]).toContain("Disregard skills from previous tickets");
      queue.moveManually(first.id, "PENDING");
      await orchestrator.run(first.id);
      invocations = readFileSync(calls, "utf8").split("CALL_START\n").slice(1);
      expect(invocations).toHaveLength(3);
      expect(invocations[2]).toContain("resume");
      expect(invocations[2]).toContain(frozen[0].content);
      expect(invocations[2]).toContain(frozen[0].path);
    } finally {
      process.env.PATH = originalPath;
      if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
