/** Formats Codex JSONL for display without importing its server-side transport. */
export function formatCodexConsole(output: string) {
  return output.split("\n").filter(Boolean).map(line => {
    if (/^Reading additional input from stdin/i.test(line)) return "";
    try {
      const event = JSON.parse(line) as unknown;
      if (!isRecord(event)) return line.slice(0, 4000);
      const item = isRecord(event.item) ? event.item : {};
      if (event.type === "thread.started") return `● Session started  ${String(event.thread_id ?? "")}`;
      if (event.type === "turn.started") return "✦ Codex is reading the project and planning…";
      if (event.type === "turn.completed") return `✓ Turn completed  ${JSON.stringify(event.usage ?? {})}`;
      if (event.type === "turn.failed" || event.type === "error") return `! ERROR  ${JSON.stringify(event.error ?? event.message ?? event)}`;
      if (item.type === "command_execution") {
        const command = String(item.command ?? "");
        const result = String(item.aggregated_output ?? "").trim().slice(-4000);
        return item.status === "in_progress" ? `$ ${command}` : result || `✓ Command finished with exit code ${String(item.exit_code ?? 0)}`;
      }
      if (item.type === "agent_message") return String(item.text ?? "");
      if (/reason/i.test(String(item.type ?? ""))) return `◆ ${String(item.text ?? "Reasoning…")}`;
      if (/file|change|patch/i.test(String(item.type ?? ""))) return `◇ Files changed  ${JSON.stringify(item.changes ?? item.path ?? item).slice(0, 4000)}`;
      return "";
    } catch { return line.slice(0, 4000); }
  }).filter(Boolean).join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
