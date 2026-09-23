import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectRecord } from "./types.js";
import { readDurableJson, writeDurableJson } from "./durable-json.js";

/** Performs this backend operation. */
export class ProjectStore {
  private projects: ProjectRecord[] = [];
  private readonly file: string;

  constructor(dataDirectory = ".jev") {
    mkdirSync(dataDirectory, { recursive: true });
    this.file = join(dataDirectory, "projects.json");
    this.projects = readDurableJson(this.file, (value): value is ProjectRecord[] => Array.isArray(value) && value.every(project => project && typeof project === "object" && typeof project.id === "string" && typeof project.path === "string" && typeof project.name === "string" && typeof project.updatedAt === "string"), () => []);
    this.persist();
  }

  private persist() { writeDurableJson(this.file, this.projects); }
  list() { return this.projects.filter(project => !project.removedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id: string) { return this.projects.find(project => project.id === id && !project.removedAt); }

  create(path: string, name?: string, context?: string): ProjectRecord {
    const absolute = resolve(path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error("The selected project directory does not exist");
    const existing = this.projects.find(project => project.path === absolute);
    if (existing) {
      if (existing.removedAt) {
        existing.removedAt = undefined;
        existing.updatedAt = new Date().toISOString();
      }
      this.ensureAgents(existing, context);
      this.persist();
      return existing;
    }
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

  private ensureAgents(project: ProjectRecord, context?: string) {
    const agentsFile = join(project.path, "AGENTS.md");
    if (existsSync(agentsFile)) return;
    if (!context?.trim()) throw new Error("Describe the application context before creating a project without AGENTS.md");
    writeFileSync(agentsFile, initialAgents(project.name, context.trim()), { encoding: "utf8", flag: "wx" });
    project.agentsCreatedByJev = true;
    project.updatedAt = new Date().toISOString();
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

  unregister(id: string) {
    const project = this.get(id);
    if (!project) throw new Error("Project not found");
    project.removedAt = new Date().toISOString();
    project.updatedAt = project.removedAt;
    this.persist();
    return project;
  }
}

function initialAgents(name: string, context: string): string {
  return `# ${name}\n\n${context}\n\n## Working rules\n\n- Follow existing project conventions and keep changes focused on the ticket.\n- Update these instructions only when lasting project guidance changes.\n`;
}
