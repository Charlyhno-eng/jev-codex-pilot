import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectStore } from "./projects.js";

describe("project AGENTS.md setup", () => {
  it("requires context and creates the initial Codex-maintained instructions only when absent", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-projects-"));
    const projectPath = join(root, "new-project");
    mkdirSync(projectPath);
    const store = new ProjectStore(join(root, "data"));

    expect(() => store.create(projectPath, "New project")).toThrow("Describe the application context");
    const project = store.create(projectPath, "New project", "A local task manager for a small studio.");
    const agents = readFileSync(join(projectPath, "AGENTS.md"), "utf8");
    expect(project.agentsCreatedByJev).toBe(true);
    expect(agents).toContain("A local task manager");
    expect(agents).toContain("JEV Codex Pilot delivery log");
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
});
