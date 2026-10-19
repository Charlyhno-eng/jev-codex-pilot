import { createCodexProvider } from "./codex/provider.js";
import type { ExecutionProvider } from "./types.js";

const factories: Record<string, () => ExecutionProvider> = { codex: createCodexProvider };

/** Finds a saved ticket's adapter without substituting a different provider for its history. */
export function findExecutionProvider(id: string): ExecutionProvider | undefined {
  return Object.hasOwn(factories, id) ? factories[id]() : undefined;
}

/** Selects the coding AI; constructing it never launches execution or installs credentials. */
export function createExecutionProvider(id = process.env.JEV_EXECUTION_PROVIDER?.trim() || "codex"): ExecutionProvider {
  const provider = findExecutionProvider(id);
  if (!provider) throw new Error(`Unknown execution provider "${id}". Register its adapter in src/core/execution/provider.ts.`);
  return provider;
}
