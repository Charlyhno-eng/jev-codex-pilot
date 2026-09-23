#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const marker = "Installed by JEV Codex Pilot";
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function writeLauncher(path, content) {
  if (existsSync(path) && !readFileSync(path, "utf8").includes(marker)) {
    throw new Error(`A different command already exists at ${path}. It was not replaced.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function updateProfile(path, statement) {
  const start = "# >>> jc-pilot PATH >>>";
  const end = "# <<< jc-pilot PATH <<<";
  const old = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = `${start}\n${statement}\n${end}`;
  const from = old.indexOf(start);
  const to = old.indexOf(end, from);
  if (from >= 0 && to < 0) throw new Error(`Incomplete jc-pilot block in ${path}; repair that block before installing again.`);
  const content = from < 0 ? `${old}${old.endsWith("\n") || !old ? "" : "\n"}\n${block}\n` : `${old.slice(0, from)}${block}${old.slice(to + end.length)}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Install a user-owned launcher; never use the global npm prefix. */
export function installCommand({
  platform = process.platform,
  userDirectory = homedir(),
  environment = process.env,
  entry = fileURLToPath(new URL("./jc-pilot.mjs", import.meta.url)),
  node = process.execPath,
  execute = execFileSync
} = {}) {
  if (platform === "win32") {
    const directory = join(environment.LOCALAPPDATA || join(userDirectory, "AppData", "Local"), "jc-pilot", "bin");
    const launcher = join(directory, "jc-pilot.cmd");
    const batchQuote = value => `"${value.replaceAll("%", "%%")}"`;
    writeLauncher(launcher, `@rem ${marker}\r\n@echo off\r\nsetlocal DisableDelayedExpansion\r\n${batchQuote(node)} ${batchQuote(entry)} %*\r\nexit /b %errorlevel%\r\n`);
    const script = "$bin = $env:JEV_INSTALL_BIN; $old = [Environment]::GetEnvironmentVariable('Path', 'User'); if (($old -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', ($bin + ';' + $old), 'User') }";
    execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...environment, JEV_INSTALL_BIN: directory }, stdio: "pipe" });
    return { launcher, instruction: "Close and reopen your terminal application, then run: jc-pilot --help" };
  }
  if (platform !== "linux" && platform !== "darwin") throw new Error(`Unsupported platform: ${platform}`);
  const directory = join(userDirectory, ".local", "bin");
  const launcher = join(directory, "jc-pilot");
  writeLauncher(launcher, `#!/bin/sh\n# ${marker}\nexec ${quote(node)} ${quote(entry)} "$@"\n`);
  chmodSync(launcher, 0o755);
  const shell = basename(environment.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/bash"));
  let profiles;
  if (shell === "fish") {
    profiles = [join(environment.XDG_CONFIG_HOME || join(userDirectory, ".config"), "fish", "conf.d", "jc-pilot.fish")];
    const fishQuote = `'${directory.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    updateProfile(profiles[0], `fish_add_path --prepend ${fishQuote}`);
  } else {
    profiles = shell === "zsh" ? [join(environment.ZDOTDIR || userDirectory, ".zshrc")]
      : shell === "bash" ? [join(userDirectory, ".bashrc"), join(userDirectory, existsSync(join(userDirectory, ".bash_profile")) ? ".bash_profile" : existsSync(join(userDirectory, ".bash_login")) ? ".bash_login" : ".profile")]
      : [join(userDirectory, ".profile")];
    const statement = `case ":$PATH:" in\n  *:${quote(directory)}:*) ;;\n  *) export PATH=${quote(directory)}:"$PATH" ;;\nesac`;
    for (const profile of profiles) updateProfile(profile, statement);
  }
  const activate = shell === "fish" ? `source ${quote(profiles[0])}` : `export PATH=${quote(directory)}:"$PATH"`;
  return { launcher, instruction: `Open a new terminal, then run: jc-pilot --help\nFor this terminal, run: ${activate}`, profiles };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error("Usage: npm run setup:cli (installs jc-pilot for your user account)");
    const result = installCommand();
    process.stdout.write(`Installed ${result.launcher}\n${result.instruction}\n`);
  } catch (error) {
    process.stderr.write(`jc-pilot setup: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
