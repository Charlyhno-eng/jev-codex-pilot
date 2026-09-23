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
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/^export (?:async )?function\s|^export const \w+\s*=\s*(?:async )?(?:<[^>]+>)?\(?[^;]*=>/.test(line)) return;
        const previous = lines[index - 1]?.trim() ?? "";
        let opening = false;
        if (previous.endsWith("*/")) {
          for (let cursor = index - 1; cursor >= 0; cursor--) {
            if (lines[cursor].includes("/**")) { opening = true; break; }
            if (cursor < index - 1 && lines[cursor].includes("*/")) break;
          }
        }
        if (!opening) undocumented.push(`${file}:${index + 1}`);
      });
    }
    expect(undocumented).toEqual([]);
  });
});
