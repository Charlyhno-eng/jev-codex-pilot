import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installCommand } from "../../bin/install-command.mjs";

describe("user command installation", () => {
  it("preserves the target directory and arguments through an installed launcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-command-"));
    const userDirectory = join(root, "user's home $with spaces");
    const project = join(root, "plain HTML project");
    const entry = join(root, "cli's entry.mjs");
    const output = join(root, "result.json");
    mkdirSync(userDirectory); mkdirSync(project);
    writeFileSync(entry, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n`);
    writeFileSync(join(userDirectory, ".zshrc"), "# existing configuration\n");
    const options = { platform: "linux", userDirectory, entry, environment: { SHELL: "/bin/zsh" } };
    const installed = installCommand(options);
    installCommand(options);
    const profile = readFileSync(join(userDirectory, ".zshrc"), "utf8");
    expect(profile).toContain("# existing configuration");
    expect(profile.match(/# >>> jc-pilot PATH >>>/g)).toHaveLength(1);
    const task = 'Un cerveau 3D : "animé", $variable et `texte`';
    await new Promise<void>((resolve, reject) => {
      const child = spawn("sh", ["-c", '. "$1"; shift; jc-pilot "$@"', "sh", join(userDirectory, ".zshrc"), "run", task], { cwd: project, stdio: "ignore" });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error(`Launcher exited with ${code}`)));
    });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ cwd: project, args: ["run", task] });
    expect(readFileSync(installed.launcher, "utf8")).toContain("Installed by JEV Codex Pilot");
  });

  it("keeps an unrelated command intact", () => {
    const userDirectory = mkdtempSync(join(tmpdir(), "jev-command-conflict-"));
    const directory = join(userDirectory, ".local", "bin");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "jc-pilot"), "another command");
    expect(() => installCommand({ platform: "linux", userDirectory, environment: { SHELL: "/bin/bash" } })).toThrow("different command");
    expect(readFileSync(join(directory, "jc-pilot"), "utf8")).toBe("another command");
  });

  it("sets up macOS login Bash and Fish startup files", () => {
    const userDirectory = mkdtempSync(join(tmpdir(), "jev-command-shells-"));
    writeFileSync(join(userDirectory, ".bash_profile"), "# login settings\n");
    installCommand({ platform: "darwin", userDirectory, environment: { SHELL: "/bin/bash" } });
    expect(readFileSync(join(userDirectory, ".bash_profile"), "utf8")).toContain("# login settings");
    expect(readFileSync(join(userDirectory, ".bashrc"), "utf8")).toContain("jc-pilot PATH");
    const fish = installCommand({ platform: "linux", userDirectory, environment: { SHELL: "/usr/bin/fish" } });
    expect(readFileSync(fish.profiles[0], "utf8")).toContain("fish_add_path");
    expect(fish.instruction).toContain("source ");
  });

  it("creates a Windows cmd launcher and updates only the user PATH", () => {
    const userDirectory = mkdtempSync(join(tmpdir(), "jev-command-windows-"));
    const execute = vi.fn();
    const installed = installCommand({ platform: "win32", userDirectory, environment: { LOCALAPPDATA: join(userDirectory, "Local") }, entry: "C:\\My project\\jc-pilot.mjs", node: "C:\\Program Files\\nodejs\\node.exe", execute });
    expect(readFileSync(installed.launcher, "utf8")).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\My project\\jc-pilot.mjs" %*');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][1].at(-1)).toContain("GetEnvironmentVariable('Path', 'User')");
    expect(execute.mock.calls[0][1].at(-1)).toContain("-notcontains $bin");
  });
});
