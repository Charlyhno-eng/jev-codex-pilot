import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectTerminals } from "../../src/core/project-terminal.js";

const terminals = new ProjectTerminals();
const roots: string[] = [];
afterEach(() => { terminals.dispose(); roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
async function waitFor(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error("Terminal did not produce the expected output"); await new Promise(resolve => setTimeout(resolve, 20)); }
}

describe("project terminals", () => {
  it("runs a persistent real shell only on start, scopes sessions, and retains output for reconnect", async () => {
    const path = mkdtempSync(join(tmpdir(), "jev-terminal-")); roots.push(path);
    expect(terminals.list("one")).toEqual([]);
    const shell = terminals.start("one", path);
    terminals.write("one", shell.id, { data: "pwd\r" });
    await waitFor(() => terminals.read("one", shell.id, 0).data.includes(path));
    const first = terminals.read("one", shell.id, 0);
    expect(terminals.read("one", shell.id, 0).data).toBe(first.data);
    expect(() => terminals.read("two", shell.id, 0)).toThrow("Terminal not found");
    expect(() => terminals.write("one", shell.id, { rows: 0, cols: 80 })).toThrow();
    terminals.write("one", shell.id, { data: "cd /tmp\r" });
    terminals.write("one", shell.id, { data: "printf 'PERSISTENT-%s-END\\n' \"$PWD\"\r" });
    await waitFor(() => terminals.read("one", shell.id, first.cursor).data.includes("PERSISTENT-/tmp-END"));
    terminals.close("one", shell.id);
    expect(terminals.list("one")).toEqual([]);
    expect(() => terminals.read("one", shell.id, 0)).toThrow();
  });

  it("supports Ctrl+C and subsequent commands and records shell exit", async () => {
    const path = mkdtempSync(join(tmpdir(), "jev-terminal-")); roots.push(path);
    const shell = terminals.start("one", path);
    terminals.write("one", shell.id, { data: "sleep 30\r" });
    await waitFor(() => terminals.read("one", shell.id, 0).data.includes("sleep 30"));
    await new Promise(resolve => setTimeout(resolve, 100));
    terminals.write("one", shell.id, { data: "\x03" });
    terminals.write("one", shell.id, { data: "printf 'AFTER-%s-END\\n' interrupt\r" });
    await waitFor(() => terminals.read("one", shell.id, 0).data.includes("AFTER-interrupt-END"));
    terminals.write("one", shell.id, { data: "exit 7\r" });
    await waitFor(() => terminals.read("one", shell.id, 0).exitCode !== undefined);
    expect(terminals.read("one", shell.id, 0).exitCode).toBe(7);
  });

  it("masks credential values split across streamed output chunks", async () => {
    const path = mkdtempSync(join(tmpdir(), "jev-terminal-")); roots.push(path);
    const shell = terminals.start("one", path);
    terminals.write("one", shell.id, { data: "stty -echo\r" });
    terminals.write("one", shell.id, { data: "printf 'api_key='; sleep 0.1; printf 'private-value\\n'; printf 'DONE-%s-END\\n' masking\r" });
    await waitFor(() => terminals.read("one", shell.id, 0).data.includes("DONE-masking-END"));
    const output = terminals.read("one", shell.id, 0).data;
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("private-value");
  });
});
