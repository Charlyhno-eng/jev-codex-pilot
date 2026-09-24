import { describe, expect, it } from "vitest";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedProjectFiles, snapshotProject } from "../../src/core/project-snapshot.js";

describe("project change tracking", () => {
  it("tracks additions, edits, and deletions", () => {
    const project = mkdtempSync(join(tmpdir(), "jev-project-changes-"));
    writeFileSync(join(project, "feature.ts"), "export const feature = 1;");
    writeFileSync(join(project, "obsolete.ts"), "export {};");
    const before = snapshotProject(project);

    writeFileSync(join(project, "feature.ts"), "export const feature = 22;");
    writeFileSync(join(project, "added.ts"), "export {};");
    unlinkSync(join(project, "obsolete.ts"));

    expect(changedProjectFiles(before, snapshotProject(project))).toEqual(["added.ts", "feature.ts", "obsolete.ts"]);
  });
});
