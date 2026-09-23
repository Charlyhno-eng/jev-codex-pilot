import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexLoopDetector } from "../../src/core/codex-loop-detector.js";

describe("Codex repetition detection", () => {
  it("stops repeated failed commands and short command-message cycles", () => {
    const project = mkdtempSync(join(tmpdir(), "jev-loop-"));
    const detector = new CodexLoopDetector(project);
    expect(detector.observe("command", "read missing.ts", "missing", 1)).toBe(false);
    expect(detector.observe("command", "read missing.ts", "missing", 1)).toBe(false);
    expect(detector.observe("command", "read missing.ts", "missing", 1)).toBe(true);
    detector.reset();
    for (let index = 0; index < 5; index++) expect(detector.observe(index % 2 ? "message" : "command", index % 2 ? "Looking again" : "cat file.ts")).toBe(false);
    expect(detector.observe("message", "Looking again")).toBe(true);
  });

  it("allows repeated actions when files change and ignores differing results", () => {
    const project = mkdtempSync(join(tmpdir(), "jev-loop-progress-"));
    const file = join(project, "progress.txt");
    writeFileSync(file, "first");
    const detector = new CodexLoopDetector(project);
    expect(detector.observe("command", "cat progress.txt", "first", 0)).toBe(false);
    expect(detector.observe("command", "cat progress.txt", "second", 0)).toBe(false);
    detector.reset();
    expect(detector.observe("command", "cat progress.txt", "first", 0)).toBe(false);
    expect(detector.observe("command", "cat progress.txt", "first", 0)).toBe(false);
    expect(detector.observe("command", "cat progress.txt", "first", 0)).toBe(false);
    writeFileSync(file, "second version");
    expect(detector.observe("command", "cat progress.txt", "first", 0)).toBe(false);
    expect(detector.observe("command", "cat progress.txt", "first", 0)).toBe(false);
  });
});
