import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import type { ProjectFile } from "./types.js";

export const DEFAULT_EXCLUSIONS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".cache", ".turbo", ".venv", "venv", "coverage", ".jev"]);

/** Performs this backend operation. */
export function listProjectFiles(projectPath: string, excluded = DEFAULT_EXCLUSIONS): ProjectFile[] {
  const root = resolve(projectPath);
  const files: ProjectFile[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (files.length >= 5000) return;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push({ path: relative(root, full), size: statSync(full).size });
    }
  }
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Performs this backend operation. */
export function readProjectFile(projectPath: string, file: string): string | undefined {
  const target = resolve(projectPath, file);
  if (!target.startsWith(`${resolve(projectPath)}/`) && target !== resolve(projectPath)) return undefined;
  return existsSync(target) ? readFileSync(target, "utf8") : undefined;
}

/** Hashes a regular project file without retaining its contents or following symlinks outside the project. */
export function projectFileFingerprint(projectPath: string, file: string): string | undefined {
  try {
    const root = realpathSync(projectPath);
    const target = resolve(projectPath, file);
    if (target === resolve(projectPath) || !target.startsWith(`${resolve(projectPath)}/`) || !lstatSync(target).isFile()) return undefined;
    const actual = realpathSync(target);
    if (!actual.startsWith(`${root}/`)) return undefined;
    if (statSync(actual).size > 2 * 1024 * 1024) return undefined;
    return createHash("sha256").update(readFileSync(actual)).digest("hex");
  } catch { return undefined; }
}
