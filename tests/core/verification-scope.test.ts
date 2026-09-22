import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { affectedTests, changedProjectFiles, snapshotProject, targetedTestCommand } from "../../src/core/verification-scope.js";

describe("targeted verification scope", () => {
  it("tracks additions, edits, and deletions and selects only related tests", () => {
    const project = mkdtempSync(join(tmpdir(), "jev-verification-scope-"));
    mkdirSync(join(project, "src"));
    mkdirSync(join(project, "tests"));
    mkdirSync(join(project, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ devDependencies: { vitest: "1.0.0" } }));
    writeFileSync(join(project, "src", "feature.ts"), "export const feature = 1;");
    writeFileSync(join(project, "src", "obsolete.ts"), "export {};");
    writeFileSync(join(project, "tests", "feature.test.ts"), "test('feature', () => {});");
    writeFileSync(join(project, "tests", "unrelated.test.ts"), "test('other', () => {});");
    writeFileSync(join(project, "node_modules", ".bin", "vitest"), "");
    const before = snapshotProject(project);

    writeFileSync(join(project, "src", "feature.ts"), "export const feature = 22;");
    writeFileSync(join(project, "src", "added.ts"), "export {};");
    unlinkSync(join(project, "src", "obsolete.ts"));
    const after = snapshotProject(project);
    const changed = changedProjectFiles(before, after);
    const selected = affectedTests(changed, after);

    expect(changed).toEqual(["src/added.ts", "src/feature.ts", "src/obsolete.ts"]);
    expect(selected).toEqual(["tests/feature.test.ts"]);
    expect(targetedTestCommand(project, selected)).toBe("./node_modules/.bin/vitest run 'tests/feature.test.ts'");
  });

  it("does not create a broad test command when no related test exists", () => {
    const project = mkdtempSync(join(tmpdir(), "jev-no-test-"));
    writeFileSync(join(project, "README.md"), "Notes");
    const current = snapshotProject(project);
    expect(affectedTests(["README.md"], current)).toEqual([]);
    expect(targetedTestCommand(project, [])).toBeUndefined();
  });

  it("finds a related test through its direct import when names differ", () => {
    const project = mkdtempSync(join(tmpdir(), "jev-import-test-"));
    mkdirSync(join(project, "src"));
    mkdirSync(join(project, "tests"));
    writeFileSync(join(project, "src", "formatter.ts"), "export const format = String;");
    writeFileSync(join(project, "tests", "display.test.ts"), "import { format } from '../src/formatter.js';\n");
    const current = snapshotProject(project);
    expect(affectedTests(["src/formatter.ts"], current, project)).toEqual(["tests/display.test.ts"]);
  });
});
