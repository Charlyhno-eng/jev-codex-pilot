import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { redactIdeText } from "./ide-files.js";

type Session = { id: string; projectId: string; process: ChildProcessWithoutNullStreams; output: string; offset: number; exitCode?: number };
const LIMIT = 256 * 1024;

/** Owns explicitly started local project shells and their bounded in-memory output. */
export class ProjectTerminals {
  private sessions = new Map<string, Session>();

  /** Lists terminal metadata without starting a process. */
  list(projectId: string) {
    return [...this.sessions.values()].filter(s => s.projectId === projectId).map(s => ({ id: s.id, exitCode: s.exitCode }));
  }

  /** Starts an interactive shell in the selected project after an explicit action. */
  start(projectId: string, path: string) {
    if (this.list(projectId).length >= 4) throw new Error("Close a terminal before opening another (maximum four per project).");
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/(?:API_?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)/i.test(key)) delete env[key];
    const child = spawn("python3", [fileURLToPath(new URL("./terminal-bridge.py", import.meta.url)), path], { env, stdio: "pipe" });
    const session: Session = { id: randomUUID(), projectId, process: child, output: "", offset: 0 };
    this.sessions.set(session.id, session);
    let line = "";
    let hidden = false;
    let privateKey = false;
    const append = (data: string) => {
      // Keep assignment detection across PTY chunks so a split credential value never escapes masking.
      let safe = "";
      for (const char of data) {
        if (char === "\r" || char === "\n") { line = ""; hidden = privateKey; safe += char; continue; }
        line = (line + char).slice(-1024);
        if (privateKey && /-----END [A-Z ]*PRIVATE KEY-----$/.test(line)) { privateKey = false; hidden = false; continue; }
        if (hidden) continue;
        if (/(?:api[_-]?key|private[_-]?key|access[_-]?key|token|secret|password|authorization)[\w-]*["']?\s*[:=]\s*$/i.test(line) || /(?:sk-|gh[pousr]_)$/.test(line) || /-----BEGIN [A-Z ]*PRIVATE KEY-----$/.test(line)) {
          privateKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----$/.test(line);
          hidden = true; safe += `${char}[REDACTED]`;
        } else safe += char;
      }
      session.output += redactIdeText(safe);
      if (session.output.length > LIMIT) { const removed = session.output.length - LIMIT; session.output = session.output.slice(removed); session.offset += removed; }
    };
    let pending = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const event = JSON.parse(pending.slice(0, end)) as { data?: string; exitCode?: number };
        pending = pending.slice(end + 1);
        if (event.data) append(event.data);
        if (event.exitCode !== undefined) session.exitCode = event.exitCode;
      }
    });
    child.stderr.on("data", () => append("\r\nTerminal bridge failed. Check Python 3 and your local shell.\r\n"));
    child.on("error", () => { append("\r\nUnable to start terminal. Python 3 is required.\r\n"); session.exitCode = 1; });
    child.on("exit", code => { session.exitCode ??= code ?? 1; });
    child.stdin.on("error", () => { /* The shell may exit while input is in flight. */ });
    return { id: session.id };
  }

  private get(projectId: string, id: string) {
    const session = this.sessions.get(id);
    if (!session || session.projectId !== projectId) throw new Error("Terminal not found.");
    return session;
  }

  /** Returns output since the client's cursor, allowing reconnects without consuming other clients' output. */
  read(projectId: string, id: string, cursor: number) {
    const s = this.get(projectId, id);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid terminal cursor.");
    return { data: s.output.slice(Math.max(0, cursor - s.offset)), cursor: s.offset + s.output.length, truncated: cursor < s.offset, exitCode: s.exitCode };
  }

  /** Sends keyboard input or validated dimensions to an active pseudoterminal. */
  write(projectId: string, id: string, input: { data?: unknown; cols?: unknown; rows?: unknown }) {
    const s = this.get(projectId, id);
    if (s.exitCode !== undefined) throw new Error("This terminal has exited. Open a new terminal.");
    const message: { data?: string; cols?: number; rows?: number } = {};
    if (input.data !== undefined) {
      if (typeof input.data !== "string" || input.data.length > 16384) throw new Error("Invalid terminal input (maximum 16 KB).");
      message.data = input.data;
    }
    if (input.cols !== undefined || input.rows !== undefined) {
      if (!Number.isInteger(input.cols) || !Number.isInteger(input.rows) || Number(input.cols) < 10 || Number(input.cols) > 500 || Number(input.rows) < 2 || Number(input.rows) > 200) throw new Error("Invalid terminal dimensions.");
      message.cols = Number(input.cols); message.rows = Number(input.rows);
    }
    s.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Closes the shell and its foreground process and forgets retained output. */
  close(projectId: string, id: string) {
    const s = this.get(projectId, id);
    s.process.kill("SIGTERM");
    this.sessions.delete(id);
  }

  /** Stops every terminal when its project is removed or the API shuts down. */
  dispose(projectId?: string) {
    for (const s of this.sessions.values()) if (!projectId || s.projectId === projectId) this.close(s.projectId, s.id);
  }
}
