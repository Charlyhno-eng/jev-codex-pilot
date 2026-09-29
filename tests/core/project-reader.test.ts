import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listProjectFiles, readProjectFile } from "../../src/core/project-reader.js";

describe("project file access", () => {
  it("lists files in stable order and skips generated directories", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-project-reader-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "z.txt"), "z");
    writeFileSync(join(root, "src", "a.ts"), "a");
    writeFileSync(join(root, "node_modules", "private.js"), "private");

    expect(listProjectFiles(root)).toEqual([
      { path: "src/a.ts", size: 1 },
      { path: "z.txt", size: 1 }
    ]);
  });

  it("reads files under the project root and refuses path traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-project-reader-"));
    const outside = join(tmpdir(), `jev-outside-${Date.now()}.txt`);
    writeFileSync(join(root, "AGENTS.md"), "project instructions");
    writeFileSync(outside, "private data");

    expect(readProjectFile(root, "AGENTS.md")).toBe("project instructions");
    expect(readProjectFile(root, `../${outside.split("/").at(-1)}`)).toBeUndefined();
  });
});
