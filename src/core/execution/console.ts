import { formatCodexConsole } from "./codex/console.js";

/** Renders saved provider output; unknown adapters retain a readable plain-text console. */
export function formatExecutionConsole(output: string, providerId = "codex"): string {
  if (providerId === "codex") return formatCodexConsole(output);
  return output.split("\n").filter(Boolean).map(line => line.slice(0, 4_000)).join("\n");
}
