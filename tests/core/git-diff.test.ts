import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProjectDiff } from "../../src/core/git-diff.js";

function git(root: string, args: string[]) { execFileSync("git", ["-C", root, ...args], { stdio: "ignore" }); }

describe("project Git diff", () => {
  it("previews initial staged files and nested untracked files", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-git-initial-diff-"));
    git(root, ["init"]);
    writeFileSync(join(root, "initial.ts"), "export const initial = true;\n");
    git(root, ["add", "initial.ts"]);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "next.ts"), "export const next = true;\n");
    const result = readProjectDiff(root);
    expect(result.files.map(file => file.path)).toEqual(["initial.ts", "src/next.ts"]);
    expect(result.files[0].diff).toContain("+export const initial = true;");
    expect(result.files[1].diff).toContain("+export const next = true;");
  });

  it("hides private files and masks credentials in working-tree and commit diffs", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-git-private-diff-"));
    git(root, ["init"]); git(root, ["config", "user.email", "tests@example.test"]); git(root, ["config", "user.name", "JEV tests"]);
    writeFileSync(join(root, ".env"), "PRIVATE_TOKEN=do-not-show\n");
    writeFileSync(join(root, "app.ts"), 'const apiKey = "do-not-show";\n');
    const initial = readProjectDiff(root);
    expect(initial.files.map(file => file.path)).toEqual(["app.ts"]);
    expect(JSON.stringify(initial)).not.toContain("do-not-show");
    git(root, ["add", "."]); git(root, ["commit", "-m", "initial"]);
    const hash = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const committed = readProjectDiff(root, hash);
    expect(committed.files.map(file => file.path)).toEqual(["app.ts"]);
    expect(JSON.stringify(committed)).not.toContain("do-not-show");
    writeFileSync(join(root, "app.ts"), 'const apiKey = "changed-private-value";\n');
    expect(JSON.stringify(readProjectDiff(root))).not.toMatch(/do-not-show|changed-private-value/);
  });

  it("refuses reading an untracked symbolic link outside the repository", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-git-link-diff-"));
    const outside = mkdtempSync(join(tmpdir(), "jev-git-private-target-"));
    git(root, ["init"]);
    writeFileSync(join(outside, "private.txt"), "external-private-data");
    symlinkSync(join(outside, "private.txt"), join(root, "link.txt"));
    const result = readProjectDiff(root);
    expect(result.files[0].path).toBe("link.txt");
    expect(JSON.stringify(result)).not.toContain("external-private-data");
  });

  it("includes both paths of a staged rename in the patch", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-git-rename-diff-"));
    git(root, ["init"]); git(root, ["config", "user.email", "tests@example.test"]); git(root, ["config", "user.name", "JEV tests"]);
    writeFileSync(join(root, "before.ts"), "export const value = 1;\n");
    git(root, ["add", "."]); git(root, ["commit", "-m", "initial"]);
    git(root, ["mv", "before.ts", "after.ts"]);
    const result = readProjectDiff(root);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe("renamed");
    expect(result.files[0].diff).toContain("rename from before.ts");
    expect(result.files[0].diff).toContain("rename to after.ts");
  });
  it("reads tracked and untracked changes since HEAD without changing the project", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-git-diff-"));
    git(root, ["init"]); git(root, ["config", "user.email", "tests@example.test"]); git(root, ["config", "user.name", "JEV tests"]);
    writeFileSync(join(root, "app.ts"), "export const title = 'before';\n");
    git(root, ["add", "app.ts"]); git(root, ["commit", "-m", "initial"]);
    writeFileSync(join(root, "app.ts"), "export const title = 'after';\n");
    writeFileSync(join(root, "notes.md"), "# New notes\n");

    const result = readProjectDiff(root);
    expect(result.base).toBe("HEAD");
    expect(result.files.map(file => file.path)).toEqual(["app.ts", "notes.md"]);
    expect(result.files.find(file => file.path === "app.ts")?.diff).toContain("-export const title = 'before';");
    expect(result.files.find(file => file.path === "notes.md")?.status).toBe("untracked");
  });
});
