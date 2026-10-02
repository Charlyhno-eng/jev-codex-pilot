import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export type GitWorkspace = { branch: string; upstream?: string; remote?: string; dirty: boolean; branches: string[]; commits: Array<{ hash: string; subject: string; date: string; author: string }> };
export type GitStart = { branch: string; head: string };

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", resolve(root), ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function branch(root: string): string {
  let name = "";
  try { name = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]); }
  catch { throw new Error("Select a branch before using Git delivery."); }
  if (!name) throw new Error("Select a branch before using Git delivery.");
  return name;
}

/** Reads branch controls and all local commits not yet present on the tracked remote. */
export function readGitWorkspace(root: string): GitWorkspace {
  const current = branch(root);
  let upstream: string | undefined;
  try { upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]); } catch { /* No upstream yet. */ }
  const remotes = git(root, ["remote"]).split("\n").filter(Boolean);
  const remote = upstream?.split("/")[0] ?? (remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined);
  const branches = git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);
  if (!branches.includes(current)) branches.unshift(current);
  let commits: GitWorkspace["commits"] = [];
  let pushedRef = upstream;
  if (!pushedRef && remote) {
    const candidate = `refs/remotes/${remote}/${current}`;
    try { git(root, ["rev-parse", "--verify", candidate]); pushedRef = candidate; } catch { /* Branch has not been pushed yet. */ }
  }
  const range = pushedRef ? [`${pushedRef}..HEAD`] : ["HEAD", "--not", "--remotes"];
  try { commits = git(root, ["log", "--format=%h%x1f%s%x1f%aI%x1f%an", ...range]).split("\n").filter(Boolean).map(line => { const [hash, subject, date, author] = line.split("\x1f"); return { hash, subject, date, author }; }); } catch { /* Empty repository. */ }
  return { branch: current, upstream, remote, dirty: Boolean(git(root, ["status", "--porcelain=v1", "--untracked-files=all"])), branches, commits };
}

/** Creates or selects a local branch after checking that the worktree is clean. */
export function selectGitBranch(root: string, name: string, create: boolean): GitWorkspace {
  if (!name || name.startsWith("-") || name === "HEAD" || name !== name.trim()) throw new Error("Enter a valid branch name.");
  try { git(root, ["check-ref-format", "--branch", name]); } catch { throw new Error("Enter a valid Git branch name."); }
  if (readGitWorkspace(root).dirty) throw new Error("Commit or discard local changes before switching branches.");
  try { git(root, create ? ["switch", "-c", name] : ["switch", name]); }
  catch { throw new Error(create ? "The branch could not be created. It may already exist." : "The branch could not be selected."); }
  return readGitWorkspace(root);
}

/** Captures the branch and HEAD before a ticket, allowing existing local changes. */
export function prepareGitDelivery(root: string): GitStart {
  if (git(root, ["rev-parse", "--show-toplevel"]) !== resolve(root)) throw new Error("Automatic Git delivery requires the selected project folder to be the Git repository root.");
  const state = readGitWorkspace(root);
  let head = "";
  try { head = git(root, ["rev-parse", "HEAD"]); } catch { /* Initial commit. */ }
  return { branch: state.branch, head };
}

/** Commits one finished ticket on its starting branch without pushing it. */
export function deliverGitTicket(root: string, start: GitStart, message: string): { status: "committed"; branch: string; commit: string; message: string } {
  const state = readGitWorkspace(root);
  if (state.branch !== start.branch) throw new Error(`The branch changed from ${start.branch} to ${state.branch} during the ticket. Git delivery stopped.`);
  let head = "";
  try { head = git(root, ["rev-parse", "HEAD"]); } catch { /* Initial commit. */ }
  if (head !== start.head) throw new Error("HEAD changed during the ticket. Review the repository before automatic Git delivery.");
  if (!message.trim()) throw new Error("A commit message is required.");
  const subject = conventionalCommitSubject(message);
  git(root, ["add", "--all"]);
  try { git(root, ["commit", "--allow-empty", "-m", subject]); }
  catch { throw new Error("Git could not create the commit. Check the repository's author identity and hooks."); }
  const commit = git(root, ["rev-parse", "--short", "HEAD"]);
  return { status: "committed", branch: start.branch, commit, message: subject };
}

/** Pushes the current branch to its configured remote when explicitly requested. */
export function pushGitBranch(root: string): GitWorkspace {
  const state = readGitWorkspace(root);
  if (!state.remote) throw new Error("Configure a Git remote before pushing this branch.");
  try { git(root, ["push", ...(state.upstream ? [] : ["--set-upstream"]), state.remote, `HEAD:refs/heads/${state.branch}`]); }
  catch { throw new Error(`Push to ${state.remote} failed. Check authentication, connectivity, and remote branch state.`); }
  return readGitWorkspace(root);
}

function conventionalCommitSubject(message: string): string {
  const subject = message.replace(/[\r\n\t]+/g, " ").trim();
  const conventional = subject.match(/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()\r\n]+\))?(!)?:\s*(\S.*)$/i);
  if (conventional) return `${conventional[1].toLowerCase()}${conventional[2] ?? ""}${conventional[3] ?? ""}: ${conventional[4]}`.slice(0, 120);
  return `chore: ${subject || "complete JEV ticket"}`.slice(0, 120);
}

/** Extracts a conventional commit subject, falling back to the ticket summary. */
export function commitMessageFromOutput(output: string, description: string): string {
  let proposed = "";
  for (const line of output.split("\n")) {
    try { const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } }; if (event.type === "item.completed" && event.item?.type === "agent_message") proposed = event.item.text?.match(/(?:^|\n)JEV_COMMIT_MESSAGE=(.+)/)?.[1] ?? proposed; }
    catch { /* Not a JSON event. */ }
  }
  return conventionalCommitSubject(proposed || description.split("\n")[0] || "Complete JEV ticket");
}
