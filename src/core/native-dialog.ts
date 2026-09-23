import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";

function execute(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => stdout += chunk.toString());
    child.stderr.on("data", chunk => stderr += chunk.toString());
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(code === 1 ? "Directory selection cancelled" : stderr.trim() || `Dialog exited with code ${code}`)));
  });
}

/** Opens the operating system folder picker and returns its selection. */
export async function selectDirectory(): Promise<string> {
  let selected = "";
  if (platform() === "linux") {
    const kde = existsSync("/usr/bin/kdialog");
    selected = kde
      ? await execute("/usr/bin/kdialog", ["--getexistingdirectory", process.cwd(), "--title", "Select a project folder"])
      : await execute("zenity", ["--file-selection", "--directory", "--title=Select a project folder"]);
  } else if (platform() === "darwin") {
    selected = await execute("osascript", ["-e", "POSIX path of (choose folder with prompt \"Select a project folder\")"]);
  } else if (platform() === "win32") {
    const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq 'OK'){Write-Output $d.SelectedPath}else{exit 1}";
    selected = await execute("powershell.exe", ["-NoProfile", "-Command", script]);
  } else throw new Error("Native folder selection is not supported on this operating system");
  if (!selected || !existsSync(selected)) throw new Error("No valid directory was selected");
  return selected.replace(/\/$/, "");
}
