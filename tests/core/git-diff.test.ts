import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProjectDiff } from "../../src/core/git-diff.js";

function git(root: string, args: string[]) { execFileSync("git", ["-C", root, ...args], { stdio: "ignore" }); }

describe("project Git diff", () => {
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
