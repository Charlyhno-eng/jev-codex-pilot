import { readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { isPrivateIdePath, readIdeFile } from "./ide-files.js";
import type { JobQueue } from "./queue.js";
import type { Job } from "./types.js";

const ignored = new Set(["vendor", "target", "out", "__pycache__", ".venv", "venv", ".gradle", ".output", ".svelte-kit"]);
const languages: Record<string, string> = { js: "JavaScript/TypeScript", jsx: "JavaScript/TypeScript", mjs: "JavaScript/TypeScript", cjs: "JavaScript/TypeScript", ts: "JavaScript/TypeScript", tsx: "JavaScript/TypeScript", mts: "JavaScript/TypeScript", cts: "JavaScript/TypeScript", py: "Python", pyw: "Python", rs: "Rust", go: "Go" };

/** Instructions applied at the beginning of explicit Codex work, including newly created projects. */
export const PROJECT_LINTER_INSTRUCTIONS = "At the beginning of project work, inspect the applicable manifests and lint tools, including nested packages. Preserve an existing usable linter and its rules. If a supported language has no usable linter, install and configure its default with the project's dependency manager: ESLint for JavaScript/TypeScript (with the TypeScript parser/plugin and React Hooks rules when applicable), Ruff check and Ruff format for Python, rustfmt and Clippy for Rust, and gofmt and go vet for Go. Use local development dependencies and update lockfiles and lint scripts; use rustup components for Rust when needed. For an empty project, set up linting as soon as this ticket introduces supported source code. Verify the installation with the relevant lint commands. Do not weaken rules, suppress failures, install unrelated dependencies, change AGENTS.md for lint setup, or run Git delivery commands. If installation is blocked, report the blocker and end with JEV_IMPLEMENTATION_BLOCKED. Linter setup belongs to project work; Push only shares existing commits.";

/** Detects missing lint setup without running commands or changing target project files. */
export function missingProjectLinters(projectPath: string, initialized: string[] = []): string[] {
  const root = resolve(projectPath);
  const files = new Set<string>();
  const eslintDirectories = new Set<string>();
  const sources = new Map<string, Set<string>>();
  function readManifest(path: string): string {
    if (!files.has(path)) return "";
    try { return readIdeFile(root, relative(root, path)).content.slice(0, 256_000); } catch { return ""; }
  }
  let visited = 0;
  function visit(directory: string, depth: number) {
    if (depth > 30 || visited >= 10_000) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++visited > 10_000) break;
      if (isPrivateIdePath(entry.name) || ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile()) {
        files.add(path);
        if (/^(?:eslint\.config\.(?:js|mjs|cjs|ts|mts|cts)|\.eslintrc(?:\.(?:js|cjs|json|yaml|yml))?)$/.test(entry.name)) eslintDirectories.add(directory);
        const language = languages[extname(entry.name).slice(1).toLowerCase()]
          ?? ({ "package.json": "JavaScript/TypeScript", "pyproject.toml": "Python", "Cargo.toml": "Rust", "go.mod": "Go" } as Record<string, string>)[entry.name];
        if (language && !/\.(?:min\.(?:js|css)|d\.(?:ts|mts|cts))$/i.test(entry.name)) {
          const directories = sources.get(language) ?? new Set<string>();
          directories.add(directory);
          sources.set(language, directories);
        }
      }
    }
  }
  visit(root, 0);
  const missing = new Set<string>();
  for (const [language, directories] of sources) {
    if (language === "Rust" || language === "Go") {
      if (!initialized.includes(language)) missing.add(`${language} toolchain lint setup`);
      continue;
    }
    for (const directory of directories) {
      let configured: boolean;
      for (let current = directory; ; current = dirname(current)) {
        const manifest = readManifest(join(current, language === "Python" ? "pyproject.toml" : "package.json"));
        if (language === "Python") {
          configured = /\b(?:ruff|flake8|pylint)\b/i.test(manifest)
            || ["requirements.txt", "requirements-dev.txt", "requirements-dev.in"].some(name => /^\s*(?:ruff|flake8|pylint)\b/m.test(readManifest(join(current, name))));
        } else {
          let dependencies: Record<string, unknown> = {};
          let inlineConfig = false;
          try { const value = JSON.parse(manifest); dependencies = { ...value.dependencies, ...value.devDependencies }; inlineConfig = Boolean(value.eslintConfig); } catch { /* A missing or malformed manifest needs Codex inspection. */ }
          configured = Boolean(dependencies.eslint && (inlineConfig || eslintDirectories.has(current)))
            || Boolean((dependencies["@biomejs/biome"] || dependencies.oxlint) && ["biome.json", "biome.jsonc", ".oxlintrc.json"].some(name => files.has(join(current, name))));
        }
        if (configured || current === root) break;
      }
      if (!configured) missing.add(`${language} (${relative(root, directory) || "."})`);
    }
  }
  return [...missing].sort();
}

/** Adds one visible setup ticket before pending work, leaving execution to an explicit Run. */
export function ensureProjectLinterTicket(queue: JobQueue, projectId: string, projectPath: string, fresh = true): Job | undefined {
  const jobs = queue.listProjectExecutionOrder(projectId);
  const existing = jobs.find(job => job.kind === "linter_setup" && !job.archivedAt && ["PENDING", "RUNNING", "ESCALATING", "SESSION_PAUSED", "FAILED"].includes(job.status));
  if (existing) return existing;
  const scans = lastScans.get(queue) ?? new Map<string, number>();
  lastScans.set(queue, scans);
  if (!fresh && Date.now() - (scans.get(projectId) ?? 0) < 30_000) return undefined;
  if (scans.size >= 128) scans.delete(scans.keys().next().value!);
  scans.set(projectId, Date.now());
  const initialized = jobs.filter(job => job.kind === "linter_setup" && job.status === "SUCCESS").flatMap(job => job.linterLanguages ?? []);
  const missing = missingProjectLinters(projectPath, initialized);
  if (!missing.length) return undefined;
  const created = queue.create(projectId, projectPath, [{ description: `Set up project linters\n\nMissing setup: ${missing.join(", ")}.\n${PROJECT_LINTER_INSTRUCTIONS}\nKeep changes focused on lint dependencies, configuration, scripts, and lockfiles. Report the actual checks run; regression tests are optional when useful for setup.` }]);
  const firstPending = jobs.find(job => job.status === "PENDING");
  const ticket = queue.update(created.id, { kind: "linter_setup", linterLanguages: missing.filter(value => value.startsWith("Rust") || value.startsWith("Go")).map(value => value.split(" ")[0]) });
  if (firstPending) queue.reorderPending(created.id, firstPending.id);
  return ticket;
}

const lastScans = new WeakMap<JobQueue, Map<string, number>>();
