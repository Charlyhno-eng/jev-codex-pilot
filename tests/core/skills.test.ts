import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillStore, type SkillFile } from "../../src/core/skills.js";
import { JobQueue } from "../../src/core/queue.js";
import { buildExecutionPrompt } from "../../src/core/prompt.js";
import type { JevAnalysis } from "../../src/core/types.js";

const roots: string[] = [];
function setup() { const root = mkdtempSync(join(tmpdir(), "jev-skills-")); roots.push(root); return { root, store: new SkillStore(root) }; }
function resource(path: string, content: string | Buffer): SkillFile { return { path, base64: Buffer.from(content).toString("base64") }; }
function instructions(name = "custom-design") { return `---\nname: ${name}\ndescription: Improve custom interface layouts.\n---\n\n# Design\nRead references/layout.md when designing a layout.\n`; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const analysis: JevAnalysis = { complexity: 3, task_types: ["ui_ux"], model: "sol", reasoning: "low", rationale: [], evaluator: "typesafe-ai/jev" };

describe("shared skill library", () => {
  it("preserves frozen versions of retired built-in skills without returning them to the library", () => {
    const { root, store } = setup();
    const skill = { id: "builtin-retired-skill", name: "retired-skill", description: "Legacy ticket guidance", source: "built-in" as const, category: "performance" as const,
      caution: { title: "Profile first", useWhen: "Measured hotspot", avoidWhen: "Routine work" },
      files: [resource("SKILL.md", instructions("retired-skill")), resource("references/kernel-guide.md", "Legacy kernel guidance")],
    };
    expect(skill.category).toBe("performance");
    expect(skill.caution).toBeDefined();
    expect(store.get(skill.id)).toBeUndefined();
    expect(() => store.select([skill.id])).toThrow();
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("rust-project", join(root, "target"), [{ description: "Optimize a measured Rust kernel" }]);
    const snapshots = store.freeze(job.id, [skill]);
    queue.update(job.id, { skills: snapshots });
    const restored = new JobQueue(join(root, "queue")).get(job.id)!.skills!;
    expect(restored[0].caution).toEqual(skill.caution);
    expect(readFileSync(join(restored[0].path, "references/kernel-guide.md"), "utf8")).toBe(Buffer.from(skill.files.find(file => file.path === "references/kernel-guide.md")!.base64, "base64").toString("utf8"));
    expect(store.updateSelection(job.id, [skill.id], restored)).toEqual(restored);
    expect(buildExecutionPrompt(job.tasks, analysis, [], restored)).toContain(restored[0].content);
    expect(existsSync(job.projectPath)).toBe(false);
    expect(store.list().filter(item => item.caution)).toEqual([]);
  });
  it("freezes Anatomy instructions, references, kit, scripts and example sources across reloads", () => {
    const { root, store } = setup();
    const [skill] = store.select(["builtin-anatomy"]);
    expect(skill.name).toBe("anatomy");
    expect(skill.provenance?.repository).toBe("wheresryan22/anatomy");
    const queue = new JobQueue(join(root, "queue"));
    const job = queue.create("project", join(root, "target"), [{ description: "Explain a cache as an interactive illustration" }]);
    const frozen = store.freeze(job.id, [skill]);
    queue.update(job.id, { skills: frozen });
    const restored = new JobQueue(join(root, "queue")).get(job.id)!.skills!;
    for (const path of ["LICENSE", "references/craft.md", "references/verify.md", "kit/iso-kit.mjs", "kit/react/live.tsx", "scripts/capture.mjs", "examples/dial-indicator/build.mjs", "examples/raptor-engine/build.mjs"]) {
      expect(readFileSync(join(restored[0].path, path))).toEqual(Buffer.from(skill.files.find(file => file.path === path)!.base64, "base64"));
    }
    // Build the bundled example from the frozen copy, proving its relative dependencies survive packaging.
    const build = join(restored[0].path, "examples/dial-indicator/build.mjs");
    execFileSync(process.execPath, [build], { timeout: 10_000 });
    execFileSync(process.execPath, [build, "--light"], { timeout: 10_000 });
    expect(readFileSync(join(restored[0].path, "examples/dial-indicator/dial-indicator.html"), "utf8")).toContain("<svg");
    expect(readFileSync(join(restored[0].path, "examples/dial-indicator/dial-indicator-light.html"), "utf8")).toContain('data-theme="light"');
    expect(restored[0].content).toContain("The object is the explanation.");
    expect(buildExecutionPrompt(job.tasks, analysis, [], restored)).toContain(restored[0].content);
    expect(store.updateSelection(job.id, [skill.id], restored)).toEqual(restored);
    expect(existsSync(job.projectPath)).toBe(false);
  });
  it("makes the README skill selectable and preserves its instructions for ticket execution", () => {
    const { store } = setup();
    const [skill] = store.select(["builtin-readme-writing"]);
    expect(skill.category).toBe("documentation");
    expect(store.list().find(item => item.id === skill.id)?.source).toBe("built-in");
    const [snapshot] = store.freeze("readme-ticket", [skill]);
    expect(readFileSync(join(snapshot.path, "SKILL.md"), "utf8")).toBe(snapshot.content);
    expect(buildExecutionPrompt([{ description: "Rewrite the README" }], analysis, [], [snapshot])).toContain(snapshot.content);
  });
  it("verifies bundled instructions against the reduced catalog", () => {
    const { store } = setup();
    const catalog = JSON.parse(readFileSync("skills/catalog.json", "utf8"));
    for (const entry of catalog) {
      const skill = store.get(`builtin-${entry.directory}`)!;
      if (entry.provenance) {
        expect(skill.provenance?.url).toMatch(/^https:\/\/github\.com\//);
        expect(skill.provenance?.repository).toBe(entry.provenance.repository);
      } else expect(skill.provenance).toBeUndefined();
      expect(skill.category).toBe(entry.category);
      for (const [path, hash] of Object.entries(entry.fileHashes)) {
        const file = skill.files.find(resource => resource.path === path)!;
        expect(createHash("sha256").update(Buffer.from(file.base64, "base64")).digest("hex")).toBe(hash);
      }
    }
    expect(store.list().map(skill => skill.id)).toEqual(["builtin-readme-writing", "builtin-anatomy"]);
    expect(store.get("builtin-frontend-design")).toBeUndefined();
    expect(store.get("builtin-rust-low-level-performance")).toBeUndefined();
  });
  it("ships README and Anatomy guidance and imports a portable folder durably", () => {
    const { root, store } = setup();
    expect(store.list()).toHaveLength(2);
    for (const skill of store.list()) expect(store.select([skill.id])[0].name).toBe(skill.name);
    const imported = store.import([resource("SKILL.md", instructions()), resource("references/layout.md", "Use intentional alignment."), resource("assets/swatch.png", Buffer.from([0, 255, 1]))]);
    const restored = new SkillStore(root);
    expect(restored.list()).toHaveLength(3);
    expect(restored.get(imported.id)?.files).toEqual(imported.files);
    expect(restored.list()[2]).not.toHaveProperty("files");
  });
  it("freezes resources per ticket across projects without altering target directories", () => {
    const { root, store } = setup();
    const imported = store.import([resource("SKILL.md", instructions()), resource("references/layout.md", "Important layout context.")]);
    const queue = new JobQueue(join(root, "queue"));
    const first = queue.create("project-one", join(root, "target-one"), [{ description: "Design the dashboard" }]);
    const next = queue.create("project-two", join(root, "target-two"), [{ description: "Explain the README" }]);
    queue.update(first.id, { skills: store.freeze(first.id, store.select([imported.id])) });
    const ticket = new JobQueue(join(root, "queue")).get(first.id)!;
    expect(ticket.skills?.[0].content).toContain("# Design");
    expect(readFileSync(join(ticket.skills![0].path, "references/layout.md"), "utf8")).toBe("Important layout context.");
    expect(existsSync(first.projectPath)).toBe(false);
    expect(existsSync(next.projectPath)).toBe(false);
    const prompt = buildExecutionPrompt(ticket.tasks, analysis, [], ticket.skills);
    expect(prompt).toContain(ticket.skills![0].content);
    expect(prompt).toContain(ticket.skills![0].path);
    const nextPrompt = buildExecutionPrompt(next.tasks, analysis, [], next.skills);
    expect(nextPrompt).not.toContain("custom-design");
    expect(nextPrompt).toContain("Disregard skills from previous tickets");
    store.remove(imported.id);
    expect(store.get(imported.id)).toBeUndefined();
    expect(store.updateSelection(first.id, [imported.id], ticket.skills)).toEqual(ticket.skills);
    expect(store.updateSelection(first.id, [], ticket.skills)).toEqual([]);
    expect(readFileSync(join(ticket.skills![0].path, "SKILL.md"), "utf8")).toBe(instructions());
    store.removeForJob(first.id);
    expect(existsSync(ticket.skills![0].path)).toBe(false);
  });
  it.each(["../escape.md", "/escape.md", "refs/../../escape", "refs\\escape", ".env", "references/.ssh/id_rsa", "references/.npmrc", "assets/certificate.key", "references/secrets.json"])("rejects unsafe or private resource paths: %s", path => {
    const { store } = setup();
    expect(() => store.import([resource("SKILL.md", instructions()), resource(path, "private")])).toThrow();
    expect(store.list()).toHaveLength(2);
  });
  it("rejects missing metadata, conflicting paths, invalid encodings, excessive resources, and invalid selections", () => {
    const { store } = setup();
    for (const files of [
      [resource("notes.md", "No skill")],
      [resource("SKILL.md", "No frontmatter")],
      [resource("SKILL.md", instructions("INVALID"))],
      [resource("SKILL.md", "---\nname: incomplete\n---\n")],
      [resource("SKILL.md", instructions()), resource("SKILL.md", instructions())],
      [resource("SKILL.md", instructions()), resource("refs", "file"), resource("refs/layout.md", "conflict")],
      [resource("SKILL.md", instructions()), { path: "refs/text", base64: "!invalid" }],
      [resource("SKILL.md", instructions() + "x".repeat(65536))],
      [resource("SKILL.md", instructions()), resource("assets/huge", "x".repeat(2 * 1024 * 1024))]
    ]) expect(() => store.import(files)).toThrow();
    for (let index = 0; index < 3; index++) store.import([resource("SKILL.md", instructions(`extra-${index}`))]);
    const ids = store.list().map(skill => skill.id);
    for (const selection of ["not-an-array", [ids[0], ids[0]], ["missing"], ids.slice(0, 4), [123]]) expect(() => store.select(selection)).toThrow();
    expect(() => store.remove(ids[0])).toThrow("Only imported");
  });
  it("accepts conventional quoted and multiline frontmatter", () => {
    const { store } = setup();
    for (const description of ['"Improve layout: preserve hierarchy."', "'Improve layout: preserve hierarchy.'", '>\n  Improve layout\n  with hierarchy.', '|\n  Improve layout\n  with hierarchy.']) {
      const skill = store.import([resource("SKILL.md", `---\nname: "quoted-design"\ndescription: ${description}\n---\nBody`)]);
      expect(skill.description).toContain("Improve layout");
    }
  });
  it("masks common credentials in instruction previews without returning raw resources", () => {
    const { store } = setup();
    const skill = store.import([resource("SKILL.md", instructions() + '\napi_key = "sample-private-value"\n'), resource("references/example.txt", "resource")]);
    const preview = store.preview(skill.id)!;
    expect(preview.content).not.toContain("sample-private-value");
    expect(preview.content).toContain("[REDACTED]");
    expect(preview.files).toEqual([{ path: "SKILL.md" }, { path: "references/example.txt" }]);
  });
});
