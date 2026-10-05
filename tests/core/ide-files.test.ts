import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listIdeFiles, readIdeFile } from "../../src/core/ide-files.js";

const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "jev-ide-")); roots.push(path); return path; }
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe("read-only IDE files", () => {
  it("excludes credential and generated files and masks source credentials", () => {
    const path = root();
    writeFileSync(join(path, ".env"), "secret");
    writeFileSync(join(path, "private.key"), "secret");
    mkdirSync(join(path, "node_modules"));
    writeFileSync(join(path, "node_modules", "index.js"), "generated");
    writeFileSync(join(path, "app.ts"), 'const apiKey = "private-value";\nexport const name = "hello";');
    expect(listIdeFiles(path).map(file => file.path)).toEqual(["app.ts"]);
    expect(readIdeFile(path, "app.ts").content).toBe('const apiKey = [REDACTED];\nexport const name = "hello";');
  });

  it("rejects traversal, external symlinks, symlinks to hidden files, and private directories", () => {
    const path = root(); const outside = root();
    writeFileSync(join(outside, "data"), "private");
    writeFileSync(join(path, ".env"), "private");
    symlinkSync(join(outside, "data"), join(path, "external.txt"));
    symlinkSync(join(path, ".env"), join(path, "alias.txt"));
    for (const file of ["../data", join(outside, "data"), "external.txt", "alias.txt", ".env", ".git/config"]) expect(() => readIdeFile(path, file)).toThrow();
  });

  it("refuses directories, oversized files, and binary data", () => {
    const path = root();
    mkdirSync(join(path, "src"));
    writeFileSync(join(path, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
    writeFileSync(join(path, "image.bin"), Buffer.from([1, 0, 2]));
    for (const file of ["src", "large.txt", "image.bin"]) expect(() => readIdeFile(path, file)).toThrow();
  });
});
