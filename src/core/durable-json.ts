import { closeSync, copyFileSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, fsyncSync, linkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Reads a validated snapshot, falling back to the last good backup. */
export function readDurableJson<T>(file: string, validate: (value: unknown) => value is T, empty: () => T): T {
  if (!existsSync(file) && !existsSync(`${file}.bak`)) return empty();
  for (const candidate of [file, `${file}.bak`]) {
    if (!existsSync(candidate)) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (!validate(value)) throw new Error("Invalid data structure");
      if (candidate !== file) {
        const damaged = `${file}.corrupt.${Date.now()}`;
        if (existsSync(file)) renameSync(file, damaged);
        copyFileSync(candidate, file);
        process.stderr.write(`[JEV] Restored ${basename(file)} from backup; damaged primary preserved as ${basename(damaged)}.\n`);
      }
      return value;
    } catch (error) {
      process.stderr.write(`[JEV] Could not read ${basename(candidate)}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  throw new Error(`No valid snapshot exists for ${file}. The original files were preserved.`);
}

/** Replaces a JSON snapshot atomically and periodically refreshes its backup. */
export function writeDurableJson(file: string, value: unknown) {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const backup = `${file}.bak`;
    if (existsSync(file)) {
      const backupTemporary = `${backup}.${randomUUID()}.tmp`;
      try { linkSync(file, backupTemporary); renameSync(backupTemporary, backup); }
      finally { if (existsSync(backupTemporary)) rmSync(backupTemporary); }
    }
    renameSync(temporary, file);
    const directory = openSync(dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    // The primary is always complete; the backup is a separate known-good snapshot.
    if (!existsSync(backup)) copyFileSync(file, backup);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) rmSync(temporary);
  }
}
