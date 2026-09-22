import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Adds project-independent native hooks to one Codex process via CLI config. */
export function codexHookArgs(): string[] {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const loader = resolve(root, "node_modules/tsx/dist/loader.mjs");
  const runner = resolve(root, "src/core/hooks/runner.ts");
  const command = `${JSON.stringify(process.execPath)} --import ${JSON.stringify(loader)} ${JSON.stringify(runner)}`;
  const handler = `{type="command",command=${JSON.stringify(command)},timeout=3}`;
  return [
    "-c", "features.hooks=true",
    "-c", `hooks.PreToolUse=[{matcher="^Bash$",hooks=[${handler}]}]`,
    "-c", `hooks.PostToolUse=[{matcher="*",hooks=[${handler}]}]`,
    "-c", `hooks.PreCompact=[{matcher="*",hooks=[${handler}]}]`
  ];
}
