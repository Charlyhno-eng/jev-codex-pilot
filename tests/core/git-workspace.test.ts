import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitMessageFromOutput, deliverGitTicket, prepareGitDelivery, pushGitBranch, readGitWorkspace, selectGitBranch } from "../../src/core/git-workspace.js";
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
    expect(readGitWorkspace(root).commits.map(commit => commit.hash)).toContain(delivered.commit);
    expect(git(root, "branch", "--show-current")).toBe("test-1");
    expect(() => git(remote, "show-ref", "--verify", "refs/heads/test-1")).toThrow();
    pushGitBranch(root);
    expect(readGitWorkspace(root).commits).toEqual([]);
    expect(git(remote, "show-ref", "--verify", "refs/heads/test-1")).toContain("refs/heads/test-1");
    expect(readGitWorkspace(root).dirty).toBe(false);
    expect(readProjectDiff(root, delivered.commit).files[0].diff).toContain("+after");
    expect(deliverGitTicket(root, { branch: "test-1", head: git(root, "rev-parse", "HEAD") }, "No change").status).toBe("committed");
  });

  it("lists every unpushed commit and excludes pushed history on a new branch", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-git-unpushed-"));
    const remote = mkdtempSync(join(tmpdir(), "jev-git-unpushed-remote-"));
    git(remote, "init", "--bare"); git(root, "init", "-b", "main");
    git(root, "config", "user.email", "tests@example.test"); git(root, "config", "user.name", "JEV tests");
    git(root, "commit", "--allow-empty", "-m", "Initial");
    git(root, "remote", "add", "origin", remote);
    pushGitBranch(root);
    selectGitBranch(root, "feature", true);
    expect(readGitWorkspace(root).commits).toEqual([]);
    for (let index = 0; index < 14; index++) git(root, "commit", "--allow-empty", "-m", `feat: ticket ${index}`);
    expect(readGitWorkspace(root).commits).toHaveLength(14);
    pushGitBranch(root);
    expect(readGitWorkspace(root).commits).toEqual([]);
    git(root, "branch", "--unset-upstream");
    git(root, "commit", "--allow-empty", "-m", "fix: latest ticket");
    expect(readGitWorkspace(root).commits.map(commit => commit.subject)).toEqual(["fix: latest ticket"]);
  });

  it("includes existing local changes in ticket commits while guarding branch changes", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-git-guard-"));
    git(root, "init", "-b", "main"); git(root, "config", "user.email", "tests@example.test"); git(root, "config", "user.name", "JEV tests");
    writeFileSync(join(root, "app.ts"), "before\n"); git(root, "add", "app.ts"); git(root, "commit", "-m", "Initial");
    writeFileSync(join(root, "app.ts"), "dirty\n");
    writeFileSync(join(root, "manual.txt"), "manual change\n");
    git(root, "add", "manual.txt");
    const start = prepareGitDelivery(root);
    expect(() => selectGitBranch(root, "other", true)).toThrow(/local changes/);
    writeFileSync(join(root, "ticket.txt"), "ticket change\n");
    deliverGitTicket(root, start, "feat: add ticket change");
    expect(git(root, "show", "HEAD:app.ts")).toBe("dirty");
    expect(git(root, "show", "HEAD:manual.txt")).toBe("manual change");
    expect(git(root, "show", "HEAD:ticket.txt")).toBe("ticket change");
    expect(readGitWorkspace(root).dirty).toBe(false);
    selectGitBranch(root, "other", true);
    expect(() => deliverGitTicket(root, start, "fix: update app")).toThrow(/branch changed/);
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
    expect(git(root, "log", "-1", "--format=%s")).toBe("chore: Update app");
    expect(readGitWorkspace(root).dirty).toBe(false);
  });

  it("preserves conventional subjects and normalizes missing or invalid prefixes", () => {
    const output = (subject: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `Done\nJEV_COMMIT_MESSAGE=${subject}` } });
    expect(commitMessageFromOutput(output("fix(images): preserve attached references"), "Fallback")).toBe("fix(images): preserve attached references");
    expect(commitMessageFromOutput(output("feat(api)!: change ticket input"), "Fallback")).toBe("feat(api)!: change ticket input");
    expect(commitMessageFromOutput(output("Update image handling"), "Fallback")).toBe("chore: Update image handling");
    expect(commitMessageFromOutput(output("custom: update app"), "Fallback")).toBe("chore: custom: update app");
    expect(commitMessageFromOutput("", "Update ticket\nExtra details")).toBe("chore: Update ticket");
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
