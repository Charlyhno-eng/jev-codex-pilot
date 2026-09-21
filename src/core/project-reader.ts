import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
