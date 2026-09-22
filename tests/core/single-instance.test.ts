import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireApiInstance } from "../../src/core/single-instance.js";

describe("API instance lock", () => {
  it("recovers a dead owner's lock and releases only its own claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-api-lock-"));
    writeFileSync(join(directory, "api.lock"), JSON.stringify({ pid: 99999999, token: "old" }));
    const release = await acquireApiInstance(directory);
    expect(JSON.parse(readFileSync(join(directory, "api.lock"), "utf8")).pid).toBe(process.pid);
    release();
    const nextRelease = await acquireApiInstance(directory);
    nextRelease();
  });
});
