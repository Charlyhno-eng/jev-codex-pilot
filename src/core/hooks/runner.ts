import { handleCodexHook } from "./adapters.js";
import type { HookEvent } from "./types.js";

/** Reads a native hook event and writes only the supported JSON response. */
async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 2_000_000) return process.stdout.write("{}\n");
  }
  try {
    const event = JSON.parse(input) as HookEvent;
    process.stdout.write(`${JSON.stringify(await handleCodexHook(event))}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
}

void main();
