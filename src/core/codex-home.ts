import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const sharedEntries = new Set(["config.toml", "auth.json", "AGENTS.md", "AGENTS.override.md", "skills", "rules"]);

function baseCodexHome() { return resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")); }

function linkSharedSettings(source: string, destination: string) {
  for (const entry of readdirSync(source)) {
    if (!sharedEntries.has(entry) && !entry.endsWith(".config.toml")) continue;
    const from = join(source, entry);
    const to = join(destination, entry);
    if (!existsSync(from)) continue;
    try { lstatSync(to); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    symlinkSync(from, to, lstatSync(from).isDirectory() ? "dir" : "file");
  }
}

function migrateSessions(source: string, destination: string, threadIds: string[]) {
  const wanted = new Set(threadIds.filter(id => /^[0-9a-f-]{36}$/i.test(id)));
  const sessions = join(source, "sessions");
  if (!wanted.size || !existsSync(sessions)) return;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { visit(path); continue; }
      if (!entry.isFile() || ![...wanted].some(id => basename(path).includes(id))) continue;
      const target = join(destination, "sessions", relative(sessions, path));
      if (existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(path, target);
      chmodSync(target, 0o600);
    }
  };
  visit(sessions);
}

/** Creates a private Codex state directory and imports this project's existing conversations. */
export function projectCodexHome(projectId: string, threadIds: string[] = []): string {
  const source = baseCodexHome();
  const identity = createHash("sha256").update(projectId).digest("hex").slice(0, 24);
  const destination = join(source, "jev-projects", identity);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);
  if (existsSync(source)) linkSharedSettings(source, destination);
  const marker = join(destination, ".jev-sessions-imported");
  if (!existsSync(marker)) {
    migrateSessions(source, destination, threadIds);
    writeFileSync(marker, "", { mode: 0o600 });
  }
  return destination;
}

/** Passes one project's private Codex home and SQLite location to a child process. */
export function projectCodexEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home };
}

/** Overrides any user-configured SQLite location for this project's Codex process. */
export function projectCodexStateArgs(home: string): string[] {
  return ["-c", `sqlite_home=${JSON.stringify(home)}`];
}
