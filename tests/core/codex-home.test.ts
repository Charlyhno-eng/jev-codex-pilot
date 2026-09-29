import { afterEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectCodexEnv, projectCodexHome, projectCodexStateArgs } from "../../src/core/codex-home.js";

const originalHome = process.env.CODEX_HOME;
let temporary = "";
afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

describe("per-project Codex state", () => {
  it("separates session files while sharing the user's authentication and config", () => {
    temporary = mkdtempSync(join(tmpdir(), "jev-codex-state-"));
    process.env.CODEX_HOME = temporary;
    writeFileSync(join(temporary, "auth.json"), "test credentials", { mode: 0o600 });
    writeFileSync(join(temporary, "config.toml"), "model = 'example'\n", { mode: 0o600 });
    const sessions = join(temporary, "sessions", "2026", "09", "29");
    mkdirSync(sessions, { recursive: true });
    const firstId = "11111111-1111-1111-1111-111111111111";
    const secondId = "22222222-2222-2222-2222-222222222222";
    const firstFile = `rollout-first-${firstId}.jsonl`;
    const secondFile = `rollout-second-${secondId}.jsonl`;
    writeFileSync(join(sessions, firstFile), "first history");
    writeFileSync(join(sessions, secondFile), "second history");

    const firstHome = projectCodexHome("project-one", [firstId]);
    const secondHome = projectCodexHome("project-two", [secondId]);
    expect(firstHome).not.toBe(secondHome);
    expect(lstatSync(join(firstHome, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(firstHome, "auth.json"))).toBe(join(temporary, "auth.json"));
    expect(lstatSync(join(secondHome, "config.toml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(firstHome, "sessions", "2026", "09", "29", firstFile), "utf8")).toBe("first history");
    expect(existsSync(join(firstHome, "sessions", "2026", "09", "29", secondFile))).toBe(false);
    expect(existsSync(join(secondHome, "sessions", "2026", "09", "29", firstFile))).toBe(false);
    expect(projectCodexEnv(firstHome)).toMatchObject({ CODEX_HOME: firstHome, CODEX_SQLITE_HOME: firstHome });
    expect(projectCodexStateArgs(firstHome)).toEqual(["-c", `sqlite_home=${JSON.stringify(firstHome)}`]);
  });
});
