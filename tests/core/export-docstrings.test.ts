import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:ts|tsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe("exported function documentation", () => {
  it("keeps a concise JSDoc next to every exported function", () => {
    const undocumented: string[] = [];
    for (const file of [...sourceFiles("src"), ...sourceFiles("bin")]) {
      const source = readFileSync(file, "utf8");
      const declaration = /^\s*export\s+(?:async\s+)?function\s+\w+|^\s*export\s+(?:const|let|var)\s+\w+\s*=/gm;
      for (const match of source.matchAll(declaration)) {
        const start = match.index ?? 0;
        const line = source.slice(0, start).split("\n").length;
        const signature = match[0].trimStart();
        if (signature.includes("=") && !source.slice(start, source.indexOf(";", start) < 0 ? source.length : source.indexOf(";", start)).match(/=>|=\s*(?:async\s*)?function\b/)) continue;
        const preceding = source.slice(0, start).trimEnd();
        const doc = preceding.match(/\/\*\*[\s\S]*?\*\/$/);
        if (!doc || /\n\s*\n/.test(preceding.slice(doc.index! + doc[0].length))) undocumented.push(`${file}:${line}`);
      }
    }
    expect(undocumented).toEqual([]);
  });
});
