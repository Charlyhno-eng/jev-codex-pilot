import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deliverGitTicket, prepareGitDelivery, pushGitBranch, readGitWorkspace, selectGitBranch } from "../../src/core/git-workspace.js";
import { readProjectDiff } from "../../src/core/git-diff.js";

function git(root: string, ...args: string[]) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

describe("project Git delivery", () => {
  it("creates a user-selected branch and commits tickets locally until the user pushes", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-git-workspace-"));
    const remote = mkdtempSync(join(tmpdir(), "jev-git-remote-"));
    git(remote, "init", "--bare"); git(root, "init", "-b", "main");
    git(root, "config", "user.email", "tests@example.test"); git(root, "config", "user.name", "JEV tests");
    writeFileSync(join(root, "app.ts"), "before\n"); git(root, "add", "app.ts"); git(root, "commit", "-m", "Initial");
    git(root, "remote", "add", "origin", remote);
    const selected = selectGitBranch(root, "test-1", true);
    expect(selected.branch).toBe("test-1");
    const start = prepareGitDelivery(root);
    writeFileSync(join(root, "app.ts"), "after\n");
    const delivered = deliverGitTicket(root, start, "Update app");
    expect(delivered.status).toBe("committed");
    expect(git(root, "branch", "--show-current")).toBe("test-1");
    expect(() => git(remote, "show-ref", "--verify", "refs/heads/test-1")).toThrow();
    pushGitBranch(root);
    expect(git(remote, "show-ref", "--verify", "refs/heads/test-1")).toContain("refs/heads/test-1");
    expect(readGitWorkspace(root).dirty).toBe(false);
    expect(readProjectDiff(root, delivered.commit).files[0].diff).toContain("+after");
    expect(deliverGitTicket(root, { branch: "test-1", head: git(root, "rev-parse", "HEAD") }, "No change").status).toBe("committed");
  });

  it("refuses a dirty starting tree and a changed branch", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-git-guard-"));
    git(root, "init", "-b", "main"); git(root, "config", "user.email", "tests@example.test"); git(root, "config", "user.name", "JEV tests");
    writeFileSync(join(root, "app.ts"), "before\n"); git(root, "add", "app.ts"); git(root, "commit", "-m", "Initial");
    writeFileSync(join(root, "app.ts"), "dirty\n");
    expect(() => prepareGitDelivery(root)).toThrow(/clean worktree/);
    expect(() => selectGitBranch(root, "other", true)).toThrow(/local changes/);
  });

  it("keeps local ticket commits independent from a failed manual push", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-git-push-failure-"));
    git(root, "init", "-b", "main"); git(root, "config", "user.email", "tests@example.test"); git(root, "config", "user.name", "JEV tests");
    writeFileSync(join(root, "app.ts"), "before\n"); git(root, "add", "app.ts"); git(root, "commit", "-m", "Initial");
    git(root, "remote", "add", "origin", join(root, "missing-remote"));
    const start = prepareGitDelivery(root);
    writeFileSync(join(root, "app.ts"), "after\n");
    expect(deliverGitTicket(root, start, "Update app").status).toBe("committed");
    expect(() => pushGitBranch(root)).toThrow(/Push to origin failed/);
    expect(git(root, "log", "-1", "--format=%s")).toBe("Update app");
    expect(readGitWorkspace(root).dirty).toBe(false);
  });

  it("creates a local first commit on an unborn branch until manually pushed", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-git-initial-"));
    const remote = mkdtempSync(join(tmpdir(), "jev-git-initial-remote-"));
    git(remote, "init", "--bare"); git(root, "init", "-b", "main"); git(root, "config", "user.email", "tests@example.test"); git(root, "config", "user.name", "JEV tests");
    git(root, "remote", "add", "origin", remote);
    expect(readGitWorkspace(root).branches).toContain("main");
    const start = prepareGitDelivery(root);
    writeFileSync(join(root, "app.ts"), "first\n");
    expect(deliverGitTicket(root, start, "Initial app").status).toBe("committed");
    pushGitBranch(root);
    expect(git(remote, "show-ref", "--verify", "refs/heads/main")).toContain("refs/heads/main");
  });
});
