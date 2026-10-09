import { isPrivateIdePath, redactIdeText } from "./ide-files.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDurableJson, writeDurableJson } from "./durable-json.js";

/** One portable skill resource, encoded for lossless browser folder imports. */
export interface SkillFile { path: string; base64: string }
/** Explains when an advanced skill is appropriate before selecting it. */
export interface SkillCaution { title: string; useWhen: string; avoidWhen: string }
/** Application-wide skill metadata and its portable resources. */
export interface LibrarySkill { caution?: SkillCaution; category?: "design" | "performance" | "architecture" | "documentation"; provenance?: { repository: string; url: string; license: string; retrievedAt: string }; id: string; name: string; description: string; source: "built-in" | "imported"; files: SkillFile[] }
/** Frozen instructions and resource directory belonging to one ticket. */
export interface TicketSkill { caution?: SkillCaution; id: string; name: string; description: string; content: string; path: string }
/** Identifies invalid skill input separately from storage or server failures. */
export class SkillValidationError extends Error {}
const MAX_BYTES = 2 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
function decodeInstructions(base64: string) {
  try { return decoder.decode(Buffer.from(base64, "base64")); }
  catch { throw new SkillValidationError("SKILL.md must be valid UTF-8 text."); }
}

function metadata(content: string) {
  const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!front) throw new SkillValidationError("SKILL.md needs YAML frontmatter with name and description.");
  const scalar = (key: string) => {
    const match = front.match(new RegExp(`^${key}:[ \\t]*([^\\n\\r]*)(?:\\r?\\n((?:[ \\t]+[^\\n]*\\r?\\n?)*))?`, "m"));
    if (!match) return "";
    let value = match[1].trim();
    const continuation = (match[2] ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).join(" ");
    if (value.startsWith('"')) {
      const quoted = value.match(/^"(?:[^"\\]|\\.)*"/);
      if (!quoted || !/^(?:\s+#.*)?$/.test(value.slice(quoted[0].length))) throw new SkillValidationError(`Invalid quoted ${key}.`);
      try { value = JSON.parse(quoted[0]) as string; } catch { throw new SkillValidationError(`Invalid quoted ${key}.`); }
    } else if (value.startsWith("'")) {
      const quoted = value.match(/^'(?:[^']|'')*'/);
      if (!quoted || !/^(?:\s+#.*)?$/.test(value.slice(quoted[0].length))) throw new SkillValidationError(`Invalid quoted ${key}.`);
      value = quoted[0].slice(1, -1).replace(/''/g, "'");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
      if (/^[>|][-+]?\d?$/.test(value)) value = continuation;
      else {
        if (/^(?:true|false|null|~)/i.test(value) || ["[", "]", "{", "}", "&", "*", "!"].some(prefix => value.startsWith(prefix))) throw new SkillValidationError(`${key} must be a YAML string.`);
        value = [value, continuation].filter(Boolean).join(" ");
      }
    }
    return value;
  };
  const name = scalar("name"), description = scalar("description");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new SkillValidationError("Skill names must contain lowercase letters, numbers, and hyphens (max 64 characters).");
  if (!description || description.length > 2000) throw new SkillValidationError("Provide a skill description of 1–2,000 characters.");
  return { name, description };
}

function validateFiles(input: unknown): SkillFile[] {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw new SkillValidationError("Import SKILL.md or a skill folder with at most 100 files.");
  let bytes = 0;
  const paths = new Set<string>();
  const files = input.map((file: unknown) => {
    if (!file || typeof file !== "object") throw new SkillValidationError("Invalid skill file.");
    const { path, base64 } = file as SkillFile;
    if (typeof path !== "string" || path.length > 240 || path.split("/").some(part => !part || part === "." || part === ".." || !/^[a-zA-Z0-9_. -]+$/.test(part)) || isPrivateIdePath(path) || /(?:^|\/)auth\.json$/i.test(path)) throw new SkillValidationError("Invalid or private skill resource path.");
    if (paths.has(path)) throw new SkillValidationError("Duplicate skill resource path.");
    paths.add(path);
    if (typeof base64 !== "string" || base64.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new SkillValidationError("Invalid skill resource encoding.");
    const size = Buffer.from(base64, "base64").length;
    if (path === "SKILL.md" && size > 64 * 1024) throw new SkillValidationError("SKILL.md must be 64 KB or smaller; place detailed guidance in references.");
    bytes += size;
    if (bytes > MAX_BYTES) throw new SkillValidationError("A skill folder must be 2 MB or smaller.");
    return { path, base64 };
  });
  if (!paths.has("SKILL.md")) throw new SkillValidationError("The selected folder must contain SKILL.md at its root.");
  if (files.some(file => file.path.split("/").slice(0, -1).some((_, index, parts) => paths.has(parts.slice(0, index + 1).join("/"))))) throw new SkillValidationError("A resource cannot be both a file and a folder.");
  metadata(decodeInstructions(files.find(file => file.path === "SKILL.md")!.base64));
  return files;
}

function validLibrary(value: unknown): value is LibrarySkill[] {
  if (!Array.isArray(value)) return false;
  try {
    return value.every(skill => {
      if (!skill || typeof skill.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(skill.id) || skill.source !== "imported") return false;
      const files = validateFiles(skill.files);
      const info = metadata(decodeInstructions(files.find(file => file.path === "SKILL.md")!.base64));
      return info.name === skill.name && info.description === skill.description;
    });
  } catch { return false; }
}

/** Stores portable skills globally and freezes selected versions outside target projects. */
export class SkillStore {
  private readonly file: string;
  private readonly snapshots: string;
  private imported: LibrarySkill[];
  private readonly builtins: LibrarySkill[];
  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    this.file = resolve(dataDirectory, "skills.json");
    this.snapshots = resolve(dataDirectory, "ticket-skills");
    this.imported = readDurableJson(this.file, validLibrary, () => []);
    const root = fileURLToPath(new URL("../../skills/", import.meta.url));
    const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8")) as Array<{ directory: string; category: LibrarySkill["category"]; caution?: SkillCaution; provenance?: LibrarySkill["provenance"] }>;
    const resources = (directory: string, prefix = ""): SkillFile[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = prefix + entry.name;
      if (entry.isDirectory()) return resources(join(directory, entry.name), path + "/");
      if (!entry.isFile()) throw new Error("Bundled skills cannot contain symbolic links.");
      return [{ path, base64: readFileSync(join(directory, entry.name)).toString("base64") }];
    });
    this.builtins = catalog.map(entry => {
      if (!/^[a-z0-9-]+$/.test(entry.directory)) throw new Error("Invalid bundled skill directory.");
      const files = validateFiles(resources(join(root, entry.directory)));
      const content = decodeInstructions(files.find(file => file.path === "SKILL.md")!.base64);
      return { id: `builtin-${entry.directory}`, ...metadata(content), category: entry.category, caution: entry.caution, provenance: entry.provenance, source: "built-in", files };
    });
  }
  /** Lists summaries without transferring full resources on every visit. */
  list() { return [...this.builtins, ...this.imported].map(({ files, ...skill }) => ({ ...skill, description: redactIdeText(skill.description), fileCount: files.length })); }
  /** Retrieves a portable skill for inspection or export. */
  get(id: string) { return [...this.builtins, ...this.imported].find(skill => skill.id === id); }
  /** Returns readable instructions with common credentials masked for the browser. */
  preview(id: string) {
    const skill = this.get(id);
    if (!skill) return undefined;
    const { files, ...info } = skill;
    return { ...info, description: redactIdeText(info.description), files: files.map(({ path }) => ({ path })), content: redactIdeText(decodeInstructions(files.find(file => file.path === "SKILL.md")!.base64)) };
  }
  /** Imports a validated folder as a distinct library version. */
  import(input: unknown) {
    const files = validateFiles(input);
    const info = metadata(decodeInstructions(files.find(file => file.path === "SKILL.md")!.base64));
    const skill: LibrarySkill = { id: randomUUID(), ...info, source: "imported", files };
    const next = [...this.imported, skill];
    writeDurableJson(this.file, next);
    this.imported = next;
    return skill;
  }
  /** Removes an imported library entry while preserving existing ticket copies. */
  remove(id: string) {
    if (!this.imported.some(skill => skill.id === id)) throw new SkillValidationError("Only imported skills can be removed.");
    const next = this.imported.filter(skill => skill.id !== id);
    writeDurableJson(this.file, next);
    this.imported = next;
  }
  /** Resolves a bounded selection before any tickets are created or edited. */
  select(ids: unknown): LibrarySkill[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > 3 || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) throw new SkillValidationError("Select up to three different skills per ticket.");
    return ids.map(id => {
      const skill = this.get(id);
      if (!skill) throw new SkillValidationError("A selected skill is no longer in the library. Remove it or select another skill.");
      return skill;
    });
  }
  /** Preserves existing ticket versions and freezes only newly attached skills. */
  updateSelection(jobId: string, ids: unknown, previous: TicketSkill[] = []): TicketSkill[] {
    if (!Array.isArray(ids) || ids.length > 3 || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) throw new SkillValidationError("Select up to three different skills per ticket.");
    const newSkills = this.select(ids.filter(id => !previous.some(skill => skill.id === id)));
    const additions = this.freeze(jobId, newSkills);
    return ids.map(id => previous.find(skill => skill.id === id) ?? additions.find(skill => skill.id === id)!);
  }
  /** Materializes selected resources in private application storage, never in a target repository. */
  freeze(jobId: string, selection: LibrarySkill[]): TicketSkill[] {
    if (!/^[a-zA-Z0-9-]+$/.test(jobId)) throw new SkillValidationError("Invalid ticket ID.");
    return selection.map(skill => {
      const directory = resolve(this.snapshots, jobId, randomUUID());
      for (const file of skill.files) {
        const path = resolve(directory, file.path);
        mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(path, Buffer.from(file.base64, "base64"), { mode: 0o600 });
      }
      return { id: skill.id, name: skill.name, ...(skill.caution ? { caution: { ...skill.caution } } : {}), description: skill.description, content: decodeInstructions(skill.files.find(file => file.path === "SKILL.md")!.base64), path: directory };
    });
  }
  /** Deletes a removed ticket's private resource copies. */
  removeForJob(jobId: string) { if (/^[a-zA-Z0-9-]+$/.test(jobId)) rmSync(resolve(this.snapshots, jobId), { recursive: true, force: true }); }
}
