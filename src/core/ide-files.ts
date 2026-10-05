import { openSync, closeSync, readFileSync, fstatSync, realpathSync, constants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_EXCLUSIONS, listProjectFiles } from "./project-reader.js";

/** Identifies private paths that must stay out of the code viewer. */
export function isPrivateIdePath(path: string): boolean {
  return path.split(/[\\/]/).some(part => DEFAULT_EXCLUSIONS.has(part) ||
    /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.codex|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part));
}

/** Masks common credential assignments before displaying source or command output. */
export function redactIdeText(text: string): string {
  return text.replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/((?:["']?\b(?:[\w-]*(?:api[_-]?key|private[_-]?key|access[_-]?key|token|secret|password|authorization)[\w-]*)["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[REDACTED]");
}

/** Lists readable source paths without generated files or credential files. */
export function listIdeFiles(projectPath: string) {
  return listProjectFiles(projectPath, new Set([...DEFAULT_EXCLUSIONS, ".ssh", ".aws", ".codex"])).filter(file => !isPrivateIdePath(file.path));
}

/** Reads bounded text files under the real project root without following private or external links. */
export function readIdeFile(projectPath: string, path: string) {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").includes("..") || isPrivateIdePath(path)) throw new Error("This file is unavailable in the code viewer.");
  const root = realpathSync(projectPath);
  const target = realpathSync(resolve(root, path));
  const actual = relative(root, target);
  if (!actual || actual.startsWith("../") || isAbsolute(actual) || isPrivateIdePath(actual)) throw new Error("This file is unavailable in the code viewer.");
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (process.platform === "linux") {
      const opened = relative(root, realpathSync(`/proc/self/fd/${fd}`));
      if (opened.startsWith("../") || isAbsolute(opened) || isPrivateIdePath(opened)) throw new Error("This file is unavailable in the code viewer.");
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Only text files up to 1 MB can be viewed.");
    const bytes = readFileSync(fd);
    if (bytes.includes(0)) throw new Error("Binary files cannot be displayed.");
    return { path, content: redactIdeText(bytes.toString("utf8")) };
  } finally { closeSync(fd); }
}
