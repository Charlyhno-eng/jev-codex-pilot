import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

const color = (code: number, value: string, enabled: boolean) => enabled ? `\u001b[38;5;${code}m${value}\u001b[0m` : value;
const clip = (value: string, width: number) => value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;

/** Collects a ticket batch in a Codex-style terminal workspace and launches it on request. */
export async function interactiveSession(projectDirectory: string, run: (tasks: string[], context?: string) => Promise<void>) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The interactive interface needs a terminal. Use jc-pilot run \"task\" in scripts.");
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const lines: string[] = [];
  let waiting: ((value: string | undefined) => void) | undefined;
  let closed = false;
  input.on("line", value => { if (waiting) { const resolve = waiting; waiting = undefined; resolve(value); } else lines.push(value); });
  input.on("close", () => { closed = true; waiting?.(undefined); waiting = undefined; });
  const ask = (prompt: string): Promise<string | undefined> => {
    if (lines.length) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(undefined);
    input.setPrompt(prompt);
    input.prompt();
    return new Promise(resolve => { waiting = resolve; });
  };
  const enabled = !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const ink = (value: string) => color(252, value, enabled);
  const muted = (value: string) => color(246, value, enabled);
  const cyan = (value: string) => color(81, value, enabled);
  const amber = (value: string) => color(221, value, enabled);
  const green = (value: string) => color(120, value, enabled);
  const red = (value: string) => color(203, value, enabled);
  const tickets: string[] = [];
  const width = () => Math.max(40, Math.min(process.stdout.columns || 80, 96)) - 2;
  const show = (message: string) => process.stdout.write(`${message}\n`);
  const panel = (text: string, foreground = 252, background = 235) => {
    const inner = width() - 4;
    const content = clip(text, inner).padEnd(inner);
    const row = `│ ${content} │`;
    show(` ${enabled ? `\u001b[48;5;${background}m\u001b[38;5;${foreground}m` : ""}${row}${enabled ? "\u001b[0m" : ""}`);
  };
  const border = (top: boolean, foreground = 81) => show(` ${color(foreground, `${top ? "╭" : "╰"}${"─".repeat(width() - 2)}${top ? "╮" : "╯"}`, enabled)}`);
  const render = (clear = true) => {
    if (clear && enabled) process.stdout.write("\u001b[2J\u001b[H");
    show("");
    border(true, 141);
    panel("◆  JEV CODEX PILOT                                      TERMINAL WORKSPACE", 255, 54);
    panel(`PROJECT   ${basename(projectDirectory)}`, 81, 235);
    panel(`PATH      ${projectDirectory}`, 246, 235);
    border(false, 141);
    show("");
    border(true, 81);
    panel(`TICKET QUEUE   ${tickets.length} READY`, tickets.length ? 120 : 221, 237);
    if (tickets.length) {
      for (const [index, task] of tickets.entries()) panel(`${String(index + 1).padStart(2, "0")}  ${task.replaceAll("\n", " ↵ ")}`, index % 2 ? 255 : 252, index % 2 ? 236 : 235);
    } else panel("No tickets yet. Type a request below to add one.", 246);
    border(false, 81);
    show("");
    border(true, tickets.length ? 120 : 221);
    panel(tickets.length ? "NEXT STEP   /run  →  analyze and execute this queue" : "NEXT STEP   type a request and press Enter", tickets.length ? 120 : 221, 236);
    panel("/paste multiline    /edit N    /remove N    /undo    /clear", 250, 235);
    panel("/tickets show queue  /help show commands  /quit leave", 246, 235);
    border(false, tickets.length ? 120 : 221);
    show("");
  };
  try {
    render();
    while (true) {
      const next = await ask(`${cyan("›")} `);
      if (next === undefined) break;
      const answer = next.trim();
      if (!answer) continue;
      if (answer === "/quit" || answer === "/exit") break;
      if (answer === "/help" || answer === "/tickets") { render(); continue; }
      if (answer === "/undo") { tickets.pop(); render(); continue; }
      if (answer === "/clear") { tickets.length = 0; render(); continue; }
      const selection = answer.match(/^\/(edit|remove)\s+(\d+)$/);
      if (selection) {
        const index = Number(selection[2]) - 1;
        if (index < 0 || index >= tickets.length) { show(amber("  Unknown ticket number.")); continue; }
        if (selection[1] === "remove") tickets.splice(index, 1);
        else {
          show(muted(`  Current text: ${tickets[index]}`));
          const replacement = (await ask(`${cyan("Edit ›")} `))?.trim();
          if (replacement) tickets[index] = replacement;
        }
        render();
        continue;
      }
      if (answer === "/paste") {
        show(amber("  Paste a multiline request. Finish with a line containing only a period."));
        const parts: string[] = [];
        while (true) {
          const part = await ask(`${muted("·")} `);
          if (part === undefined) return;
          if (part.trim() === ".") break;
          parts.push(part);
        }
        const task = parts.join("\n").trim();
        if (task) tickets.push(task);
        render();
        continue;
      }
      if (answer === "/run") {
        if (!tickets.length) { show(amber("  Add at least one ticket before running.")); continue; }
        let context: string | undefined;
        if (!existsSync(join(projectDirectory, "AGENTS.md"))) {
          show(amber("  This project needs a short description to create AGENTS.md."));
          context = (await ask(`${cyan("Project ›")} `))?.trim();
          if (!context) { show(amber("  A project description is required to continue.")); continue; }
        }
        const batch = [...tickets];
        tickets.length = 0;
        input.pause();
        show(`\n  ${green("●")} ${ink(`Running ${batch.length} ticket${batch.length > 1 ? "s" : ""} in order…`)}\n`);
        try { await run(batch, context); }
        catch (error) {
          if (!(error instanceof Error && "ticketsPersisted" in error)) tickets.unshift(...batch);
          show(red(`  Error: ${error instanceof Error ? error.message : String(error)}`));
          show(muted(error instanceof Error && "ticketsPersisted" in error
            ? "  Created tickets remain in JEV history. Check their status before running again."
            : "  Requests remain in the queue. Fix the issue, then use /run."));
        }
        input.resume();
        render(false);
        continue;
      }
      if (answer.startsWith("/")) { show(amber("  Unknown command. Use /help.")); continue; }
      tickets.push(answer);
      render();
    }
  } finally { input.close(); show(muted("  Session ended.")); }
}
