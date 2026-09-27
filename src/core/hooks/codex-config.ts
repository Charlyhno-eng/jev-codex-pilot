import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Adds project-independent native hooks to one Codex process via CLI config. */
export function codexHookArgs(): string[] {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const loader = resolve(root, "node_modules/tsx/dist/loader.mjs");
  const runner = resolve(root, "src/core/hooks/runner.ts");
  const command = `${JSON.stringify(process.execPath)} --import ${JSON.stringify(loader)} ${JSON.stringify(runner)}`;
  const shellHandler = `{type="command",command=${JSON.stringify(command)},timeout=3}`;
  const compactHandler = `{type="command",command=${JSON.stringify(command)},timeout=60}`;
  const restoreHandler = `{type="command",command=${JSON.stringify(command)},timeout=10,additionalContextLimit=40000}`;
  return [
    "-c", "features.hooks=true",
    "-c", `hooks.PreToolUse=[{matcher="^Bash$",hooks=[${shellHandler}]}]`,
    "-c", `hooks.PreCompact=[{matcher="^(manual|auto)$",hooks=[${compactHandler}]}]`,
    "-c", `hooks.SessionStart=[{matcher="^compact$",hooks=[${restoreHandler}]}]`
  ];
}
