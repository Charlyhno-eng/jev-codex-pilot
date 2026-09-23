import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectFileFingerprint } from "../../src/core/project-reader.js";

describe("project context fingerprints", () => {
  it("changes when file content changes and rejects external paths or symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-fingerprint-"));
    const project = join(root, "project");
    mkdirSync(project);
    const file = join(project, "AGENTS.md");
    writeFileSync(file, "first");
    const first = projectFileFingerprint(project, "AGENTS.md");
    writeFileSync(file, "second");
    expect(projectFileFingerprint(project, "AGENTS.md")).not.toBe(first);
    expect(projectFileFingerprint(project, "../outside.md")).toBeUndefined();
    const outside = join(root, "outside.md");
    writeFileSync(outside, "private");
    symlinkSync(outside, join(project, "linked.md"));
    expect(projectFileFingerprint(project, "linked.md")).toBeUndefined();
  });
});
