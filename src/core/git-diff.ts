import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type ProjectDiffFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  diff: string;
};

export type ProjectDiff = {
  base: string;
  files: ProjectDiffFile[];
};

function git(projectPath: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", projectPath, ...args], { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
}

function statusFor(code: string): ProjectDiffFile["status"] {
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

function syntheticUntrackedDiff(projectPath: string, path: string): string {
  const target = resolve(projectPath, path);
  if (!target.startsWith(`${resolve(projectPath)}/`) || !existsSync(target) || !statSync(target).isFile()) return "";
  const content = readFileSync(target);
  if (content.includes(0) || content.length > 250_000) return `diff --git a/${path} b/${path}\nBinary or oversized untracked file omitted from preview.\n`;
  const lines = content.toString("utf8").split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map(line => `+${line}`)
  ].join("\n");
}

/** Reads Git state only; it never changes the selected project. */
/** Performs this backend operation. */
export function readProjectDiff(projectPath: string): ProjectDiff {
  const root = resolve(projectPath);
  let base = "HEAD";
  try { git(root, ["rev-parse", "--verify", "HEAD"]); } catch { base = "working tree (no commit yet)"; }
  let rawStatus: Buffer;
  try { rawStatus = git(root, ["status", "--porcelain=v1", "-z"]); }
  catch { throw new Error("Git changes are unavailable because this folder is not a Git repository."); }
  const entries = rawStatus.toString("utf8").split("\0").filter(Boolean);
  const files: ProjectDiffFile[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    if (code === "??") {
      files.push({ path, status: "untracked", diff: syntheticUntrackedDiff(root, path) });
      continue;
    }
    // A rename record carries its former path as the next NUL-delimited entry.
    if (code.includes("R") || code.includes("C")) index++;
    const diffArgs = base === "HEAD" ? ["diff", "--no-ext-diff", "--find-renames", "--unified=4", "HEAD", "--", path] : ["diff", "--no-ext-diff", "--unified=4", "--", path];
    let diff = "";
    try { diff = git(root, diffArgs).toString("utf8"); } catch { /* The status entry remains useful even when Git has no textual patch. */ }
    files.push({ path, status: statusFor(code), diff: diff || `No textual diff is available for ${path}.` });
  }
  return { base, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
