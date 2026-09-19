import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectRecord } from "./types.js";

export class ProjectStore {
  private projects: ProjectRecord[] = [];
  private readonly file: string;

  constructor(dataDirectory = ".jev") {
    mkdirSync(dataDirectory, { recursive: true });
    this.file = join(dataDirectory, "projects.json");
    if (existsSync(this.file)) this.projects = JSON.parse(readFileSync(this.file, "utf8"));
    this.persist();
  }

  private persist() { writeFileSync(this.file, JSON.stringify(this.projects, null, 2)); }
  list() { return [...this.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id: string) { return this.projects.find(project => project.id === id); }

  create(path: string, name?: string, context?: string): ProjectRecord {
    const absolute = resolve(path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error("The selected project directory does not exist");
    const existing = this.projects.find(project => project.path === absolute);
    if (existing) return existing;
    const agentsFile = join(absolute, "AGENTS.md");
    const hasAgents = existsSync(agentsFile);
    if (!hasAgents && !context?.trim()) throw new Error("Describe the application context before creating a project without AGENTS.md");
    const now = new Date().toISOString();
    const project = { id: randomUUID(), name: name?.trim() || basename(absolute), path: absolute, agentsCreatedByJev: !hasAgents, createdAt: now, updatedAt: now };
    if (!hasAgents) writeFileSync(agentsFile, initialAgents(project.name, context!.trim()), { encoding: "utf8", flag: "wx" });
    this.projects.push(project);
    this.persist();
    return project;
  }

  hasAgents(id: string): boolean {
    const project = this.get(id);
    return Boolean(project && existsSync(join(project.path, "AGENTS.md")));
  }

  initializeAgents(id: string, context: string): ProjectRecord {
    const project = this.get(id);
    if (!project) throw new Error("Project not found");
    const agentsFile = join(project.path, "AGENTS.md");
    if (existsSync(agentsFile)) return project;
    if (!context.trim()) throw new Error("Describe the application context before creating AGENTS.md");
    writeFileSync(agentsFile, initialAgents(project.name, context.trim()), { encoding: "utf8", flag: "wx" });
    project.agentsCreatedByJev = true;
    project.updatedAt = new Date().toISOString();
    this.persist();
    return project;
  }

  readAgents(id: string): string {
    const project = this.get(id);
    if (!project) throw new Error("Project not found");
    const agentsFile = join(project.path, "AGENTS.md");
    if (!existsSync(agentsFile)) throw new Error("AGENTS.md has not been created for this project yet");
    return readFileSync(agentsFile, "utf8");
  }

  updateAgents(id: string, content: string): string {
    const project = this.get(id);
    if (!project) throw new Error("Project not found");
    if (!content.trim()) throw new Error("AGENTS.md cannot be empty");
    const agentsFile = join(project.path, "AGENTS.md");
    if (!existsSync(agentsFile)) throw new Error("AGENTS.md has not been created for this project yet");
    writeFileSync(agentsFile, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    project.updatedAt = new Date().toISOString();
    this.persist();
    return this.readAgents(id);
  }

  touch(id: string) {
    const project = this.get(id);
    if (!project) return;
    project.updatedAt = new Date().toISOString();
    this.persist();
  }
}

function initialAgents(name: string, context: string): string {
  return `# ${name}\n\n## Application context\n\n${context}\n\n## JEV Codex Pilot delivery log\n\nThis file is automatically maintained by Codex. At the end of each completed feature, append one concise bullet describing what was added or changed.\n`;
}
