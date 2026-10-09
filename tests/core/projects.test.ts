import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectStore } from "../../src/core/projects.js";

describe("project AGENTS.md setup", () => {
  it("removes the obsolete push linter preference while preserving human review", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-project-linter-"));
    const projectPath = join(root, "project"); mkdirSync(projectPath);
    writeFileSync(join(projectPath, "AGENTS.md"), "# Instructions\n");
    const data = join(root, "data"); const store = new ProjectStore(data);
    const project = store.create(projectPath);
    store.setHumanInTheLoop(project.id, true);
    const file = join(data, "projects.json");
    const legacy = JSON.parse(readFileSync(file, "utf8"));
    legacy[0].linterEnabled = true;
    writeFileSync(file, JSON.stringify(legacy));
    const restored = new ProjectStore(data);
    expect(restored.get(project.id)?.humanInTheLoop).toBe(true);
    expect(restored.get(project.id)).not.toHaveProperty("linterEnabled");
    expect(readFileSync(join(projectPath, "AGENTS.md"), "utf8")).toBe("# Instructions\n");
  });
  it("persists the per-project Git delivery choice", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-project-git-"));
    const projectPath = join(root, "project");
    mkdirSync(projectPath);
    writeFileSync(join(projectPath, "AGENTS.md"), "# Project\n");
    const data = join(root, "data");
    const store = new ProjectStore(data);
    const project = store.create(projectPath);
    expect(store.setAutoCommitPush(project.id, true).autoCommitPush).toBe(true);
    expect(new ProjectStore(data).get(project.id)?.autoCommitPush).toBe(true);
  });
  it("requires context and creates concise project instructions only when absent", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-projects-"));
    const projectPath = join(root, "new-project");
    mkdirSync(projectPath);
    const store = new ProjectStore(join(root, "data"));

    expect(() => store.create(projectPath, "New project")).toThrow("Describe the application context");
    const project = store.create(projectPath, "New project", "A local task manager for a small studio.");
    const agents = readFileSync(join(projectPath, "AGENTS.md"), "utf8");
    expect(project.agentsCreatedByJev).toBe(true);
    expect(agents).toContain("A local task manager");
    expect(agents).toContain("Follow existing project conventions");
    expect(agents).not.toContain("delivery log");
  });

  it("leaves an existing AGENTS.md unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-projects-"));
    const projectPath = join(root, "existing-project");
    mkdirSync(projectPath);
    const agentsPath = join(projectPath, "AGENTS.md");
    writeFileSync(agentsPath, "# Existing instructions\n");
    const store = new ProjectStore(join(root, "data"));

    const project = store.create(projectPath, "Existing project");
    expect(project.agentsCreatedByJev).toBe(false);
    expect(readFileSync(agentsPath, "utf8")).toBe("# Existing instructions\n");
    expect(store.hasAgents(project.id)).toBe(true);
    expect(existsSync(agentsPath)).toBe(true);
  });

  it("creates AGENTS.md from the supplied context when a previously registered project is missing it", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-projects-existing-"));
    const projectPath = join(root, "existing-project");
    mkdirSync(projectPath);
    const store = new ProjectStore(join(root, "data"));
    const registered = store.create(projectPath, "Existing project", "Original project context.");
    const agentsPath = join(projectPath, "AGENTS.md");

    unlinkSync(agentsPath);

    expect(() => store.create(projectPath, "Existing project")).toThrow("Describe the application context");
    const restored = store.create(projectPath, "Existing project", "Context entered in the creation modal.");

    expect(restored.id).toBe(registered.id);
    expect(readFileSync(agentsPath, "utf8")).toContain("Context entered in the creation modal.");
  });

  it("reads and updates the complete saved AGENTS.md", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-projects-"));
    const projectPath = join(root, "editable-project");
    mkdirSync(projectPath);
    const store = new ProjectStore(join(root, "data"));
    const project = store.create(projectPath, "Editable project", "Initial full context.");

    expect(store.readAgents(project.id)).toContain("Initial full context.");
    expect(store.updateAgents(project.id, "# Edited instructions\n\nThe complete context.")).toBe("# Edited instructions\n\nThe complete context.\n");
    expect(readFileSync(join(projectPath, "AGENTS.md"), "utf8")).toBe("# Edited instructions\n\nThe complete context.\n");
  });

  it("removes only the JEV workspace entry and restores it when the same folder is re-added", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-project-remove-"));
    const projectPath = join(root, "removable-project");
    mkdirSync(projectPath);
    const store = new ProjectStore(join(root, "data"));
    const project = store.create(projectPath, "Removable project", "A project that stays on disk.");

    store.unregister(project.id);
    expect(store.list()).toEqual([]);
    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(join(projectPath, "AGENTS.md"))).toBe(true);

    const restored = store.create(projectPath);
    expect(restored.id).toBe(project.id);
    expect(store.list()).toHaveLength(1);
  });
});
