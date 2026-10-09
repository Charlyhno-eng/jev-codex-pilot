import { readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { isPrivateIdePath } from "./ide-files.js";

const extensions: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", pyw: "Python", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", kts: "Kotlin",
  c: "C", h: "C", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", cs: "C#",
  rb: "Ruby", php: "PHP", swift: "Swift", dart: "Dart", scala: "Scala", sc: "Scala",
  lua: "Lua", r: "R", jl: "Julia", ex: "Elixir", exs: "Elixir", erl: "Erlang",
  hs: "Haskell", ml: "OCaml", clj: "Clojure", pl: "Perl", pm: "Perl",
  sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell", sql: "SQL",
  html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", sass: "Sass", less: "Less",
  vue: "Vue", svelte: "Svelte", qml: "QML", m: "Objective-C", mm: "Objective-C++", zig: "Zig", proto: "Protocol Buffers"
};
const generated = new Set(["vendor", "target", "out", "__pycache__", ".idea", ".gradle", ".svelte-kit", ".output", "site-packages"]);

/** Detects source languages by filename without reading contents or following symbolic links. */
export function detectProjectLanguages(projectPath: string): string[] {
  const counts = new Map<string, number>();
  let visited = 0;
  function visit(directory: string, depth: number) {
    if (depth > 30 || visited >= 10_000) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++visited > 10_000) break;
      if (isPrivateIdePath(entry.name) || generated.has(entry.name)) continue;
      if (entry.isDirectory()) visit(join(directory, entry.name), depth + 1);
      else if (entry.isFile() && !/\.(?:min\.(?:js|css)|d\.(?:ts|mts|cts))$/i.test(entry.name)) {
        const language = extensions[extname(entry.name).slice(1).toLowerCase()];
        if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
      }
    }
  }
  visit(resolve(projectPath), 0);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([language]) => language);
}

/** Caches bounded source scans for thirty seconds to keep project requests lightweight. */
export class ProjectLanguages {
  private readonly cache = new Map<string, { expires: number; languages: string[] }>();
  get(path: string): string[] {
    const key = resolve(path);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.languages;
    const languages = detectProjectLanguages(key);
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expires: Date.now() + 30_000, languages });
    return languages;
  }
}
