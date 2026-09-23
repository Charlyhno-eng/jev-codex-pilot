import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexModelId, defaultRoute, MODEL_LEVELS, readCodexSettings, REASONING_LEVELS } from "../../src/core/codex-models.js";
import { selectCodexModelId } from "../../src/core/codex-catalog.js";

afterEach(() => { delete process.env.JEV_CODEX_MODEL_LUNA; });

describe("Codex model catalog", () => {
  it("keeps stable tiers and resolves renamed model IDs from configuration", () => {
    expect(MODEL_LEVELS).toEqual(["luna", "sol", "astra"]);
    expect(REASONING_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    process.env.JEV_CODEX_MODEL_LUNA = "gpt-future-luna";
    expect(codexModelId("luna")).toBe("gpt-future-luna");
  });

  it("applies the six configured default routes", () => {
    expect([0, 1, 2, 3, 4, 5].map(level => defaultRoute(level as 0 | 1 | 2 | 3 | 4 | 5))).toEqual([
      { model: "luna", reasoning: "low" },
      { model: "luna", reasoning: "medium" },
      { model: "sol", reasoning: "medium" },
      { model: "sol", reasoning: "medium" },
      { model: "sol", reasoning: "xhigh" },
      { model: "astra", reasoning: "high" }
    ]);
  });

  it("picks a renamed installed model when the old ID disappears", () => {
    const available = [{ model: "gpt-5.7-luna", displayName: "GPT-5.7 Luna" }, { model: "gpt-5.7-terra", displayName: "GPT-5.7 Terra" }];
    expect(selectCodexModelId("luna", available)).toBe("gpt-5.7-luna");
    expect(selectCodexModelId("sol", available)).toBe(codexModelId("sol"));
  });

  it("loads each complexity route from TOML and permits a newly configured model", () => {
    const file = join(mkdtempSync(join(tmpdir(), "jev-model-routes-")), "model.toml");
    const content = readFileSync(resolve("config/model.toml"), "utf8")
      .replace('astra = "gpt-6-astra"', 'astra = "gpt-6-astra"\nnova = "gpt-next-nova"')
      .replace('routes = ["sol:medium", "sol:high"]', 'routes = ["nova:high", "sol:medium"]');
    writeFileSync(file, content);
    expect(readCodexSettings(file).complexityRoutes[3]).toEqual([
      { model: "nova", reasoning: "high" }, { model: "sol", reasoning: "medium" }
    ]);
    expect(defaultRoute(0)).toEqual({ model: "luna", reasoning: "low" });
  });

  it("rejects routes whose model or reasoning is not configured", () => {
    const file = join(mkdtempSync(join(tmpdir(), "jev-invalid-routes-")), "model.toml");
    writeFileSync(file, readFileSync(resolve("config/model.toml"), "utf8").replace("sol:xhigh", "unknown:xhigh"));
    expect(() => readCodexSettings(file)).toThrow(/Invalid complexity 4 route/);
  });
});
