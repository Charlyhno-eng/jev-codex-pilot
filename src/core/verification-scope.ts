import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
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

function testStem(path: string): string {
  return basename(path, extname(path)).replace(/^(test_|spec_)/, "").replace(/\.(test|spec)$|_(test|spec)$/, "").toLowerCase();
}

function isTest(path: string): boolean {
  return /(?:^|\/)(?:test_|spec_)[^/]+\.(?:py|js|jsx|ts|tsx)$|\.(?:test|spec)\.(?:js|jsx|ts|tsx)$|_test\.go$/i.test(path);
}

/** Selects existing tests that correspond to files changed by this ticket. */
export function affectedTests(changed: string[], current: ProjectSnapshot, projectPath?: string): string[] {
  const tests = [...current.keys()].filter(isTest);
  const selected = new Set<string>();
  const contents = new Map<string, string>();
  for (const path of changed) {
    if (current.has(path) && isTest(path)) selected.add(path);
    if (isTest(path)) continue;
    const stem = testStem(path);
    if (!stem || ["index", "main", "init", "__init__"].includes(stem)) continue;
    for (const test of tests) {
      const sameStem = testStem(test) === stem;
      const adjacent = dirname(test) === dirname(path) || dirname(test).endsWith(`/${dirname(path)}`);
      let importsChangedFile = false;
      if (projectPath && current.get(test)!.size <= 64_000) {
        const importPath = relative(dirname(test), path).replace(/\.[^.]+$/, "");
        try {
          if (!contents.has(test)) contents.set(test, readFileSync(join(projectPath, test), "utf8"));
          importsChangedFile = contents.get(test)!.includes(importPath);
        } catch { /* The test may have disappeared during the snapshot. */ }
      }
      if ((sameStem && (adjacent || tests.length <= 20)) || importsChangedFile) selected.add(test);
    }
  }
  return [...selected].sort().slice(0, 12);
}

function quote(path: string): string { return `'${path.replace(/'/g, "'\\''")}'`; }

/** Builds one test command limited to selected files. */
export function targetedTestCommand(projectPath: string, tests: string[]): string | undefined {
  if (!tests.length) return undefined;
  const pythonTests = tests.filter(path => extname(path) === ".py");
  const javascriptTests = tests.filter(path => [".ts", ".tsx", ".js", ".jsx"].includes(extname(path)));
  if (pythonTests.length + javascriptTests.length !== tests.length) return undefined;
  const commands: string[] = [];
  if (pythonTests.length) {
    const python = existsSync(join(projectPath, ".venv", "bin", "python")) ? ".venv/bin/python" : "python";
    commands.push(`${python} -m pytest ${pythonTests.map(quote).join(" ")}`);
  }
  if (javascriptTests.length) {
    const packagePath = join(projectPath, "package.json");
    if (!existsSync(packagePath)) return undefined;
    let packageJson: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try { packageJson = JSON.parse(readFileSync(packagePath, "utf8")); } catch { return undefined; }
    const declared = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const script = packageJson.scripts?.test ?? "";
    const runner = declared.vitest || /vitest/.test(script) ? "vitest" : declared.jest || /jest/.test(script) ? "jest" : undefined;
    if (!runner || !existsSync(join(projectPath, "node_modules", ".bin", runner))) return undefined;
    commands.push(`./node_modules/.bin/${runner} ${runner === "vitest" ? "run " : ""}${javascriptTests.map(quote).join(" ")}`);
  }
  return commands.join(" && ") || undefined;
}
