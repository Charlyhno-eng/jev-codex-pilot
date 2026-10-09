import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectProjectLanguages, ProjectLanguages } from "../../src/core/project-languages.js";

const roots: string[] = [];
function setup() { const root = mkdtempSync(join(tmpdir(), "jev-languages-")); roots.push(root); return root; }
function file(root: string, path: string) { const target = join(root, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, ""); }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("project language detection", () => {
  it("groups source extensions and orders languages by file count", () => {
    const root = setup();
    for (const path of ["src/main.ts", "src/View.tsx", "src/task.mts", "scripts/run.py", "scripts/build.py", "src/main.rs", "public/app.css", "README.md", "package.json"]) file(root, path);
    expect(detectProjectLanguages(root)).toEqual(["TypeScript", "Python", "CSS", "Rust"]);
  });
  it("detects every supported extension in nested and mixed-language packages", () => {
    const root = setup();
    for (const path of ["app.js", "app.jsx", "app.mjs", "app.cjs", "src/app.ts", "src/app.tsx", "src/app.mts", "src/app.cts", "python/app.py", "python/gui.pyw", "rust/src/lib.rs", "go/service/main.go"]) file(root, path);
    expect(detectProjectLanguages(root)).toEqual(["JavaScript", "TypeScript", "Python", "Go", "Rust"]);
  });
  it("ignores generated and private paths, declarations, minified files, and external links", () => {
    const root = setup(), external = setup();
    file(root, "src/main.go"); file(external, "secret.rs");
    for (const path of ["node_modules/a/index.js", "target/main.rs", "dist/main.js", ".git/hooks/a.sh", ".aws/script.py", ".codex/main.py", "vendor/main.php", "src/app.d.ts", "public/app.min.js", "secret.py", ".env.py"]) file(root, path);
    symlinkSync(external, join(root, "linked")); symlinkSync(join(external, "secret.rs"), join(root, "linked.rs"));
    expect(detectProjectLanguages(root)).toEqual(["Go"]);
  });
  it("handles empty and missing folders and refreshes cached results after thirty seconds", () => {
    const root = setup();
    expect(detectProjectLanguages(root)).toEqual([]);
    expect(detectProjectLanguages(join(root, "missing"))).toEqual([]);
    const time = vi.spyOn(Date, "now").mockReturnValue(1000);
    const languages = new ProjectLanguages();
    file(root, "main.py"); expect(languages.get(root)).toEqual(["Python"]);
    file(root, "main.rs"); expect(languages.get(root)).toEqual(["Python"]);
    time.mockReturnValue(31_001); expect(languages.get(root)).toEqual(["Python", "Rust"]);
  });
});
