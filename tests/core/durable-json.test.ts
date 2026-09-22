import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDurableJson, writeDurableJson } from "../../src/core/durable-json.js";

describe("durable JSON recovery", () => {
  it("restores a valid backup while preserving a damaged primary", () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-durable-"));
    const file = join(directory, "jobs.json");
    writeDurableJson(file, [{ id: "one" }]);
    writeDurableJson(file, [{ id: "one" }, { id: "two" }]);
    writeFileSync(file, "{unfinished");

    const recovered = readDurableJson(file, (value): value is Array<{ id: string }> => Array.isArray(value) && value.every(item => typeof item.id === "string"), () => []);
    expect(recovered).toEqual([{ id: "one" }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(recovered);
  });

  it("refuses to replace data when both snapshots are invalid", () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-durable-"));
    const file = join(directory, "jobs.json");
    writeFileSync(file, "{");
    writeFileSync(`${file}.bak`, "{}");
    expect(() => readDurableJson(file, (value): value is string[] => Array.isArray(value), () => [])).toThrow("No valid snapshot");
    expect(readFileSync(file, "utf8")).toBe("{");
  });
});
