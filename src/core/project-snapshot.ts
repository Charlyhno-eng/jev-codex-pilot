import { statSync } from "node:fs";
import { join } from "node:path";
import { listProjectFiles } from "./project-reader.js";

type Fingerprint = { size: number; modified: number };
export type ProjectSnapshot = Map<string, Fingerprint>;

/** Captures project file metadata without changing the target project. */
export function snapshotProject(projectPath: string): ProjectSnapshot {
  return new Map(listProjectFiles(projectPath).map(file => {
    const stat = statSync(join(projectPath, file.path));
    return [file.path, { size: stat.size, modified: stat.mtimeMs }];
  }));
}

/** Finds files added, changed, or removed since Codex started. */
export function changedProjectFiles(before: ProjectSnapshot, after: ProjectSnapshot): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(path => {
      const old = before.get(path);
      const current = after.get(path);
      return !old || !current || old.size !== current.size || old.modified !== current.modified;
    })
    .sort();
}
