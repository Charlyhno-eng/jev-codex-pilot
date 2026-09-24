import { createHash } from "node:crypto";
import { changedProjectFiles, snapshotProject, type ProjectSnapshot } from "./project-snapshot.js";

/** Detects repeated Codex actions while allowing repetitions that change project files. */
export class CodexLoopDetector {
  private actions: string[] = [];
  private baseline?: ProjectSnapshot;

  constructor(private readonly projectPath: string) {}

  reset() { this.actions = []; this.baseline = undefined; }

  observe(kind: "command" | "message", value: string, output = "", exitCode?: number): boolean {
    if (!value.trim()) return false;
    const signature = createHash("sha256").update(JSON.stringify([kind, value.trim(), output, exitCode])).digest("hex");
    try { if (!this.baseline) this.baseline = snapshotProject(this.projectPath); }
    catch { this.reset(); return false; }
    if (this.baseline.size >= 5000) { this.reset(); return false; }
    this.actions.push(signature);
    if (this.actions.length > 6) this.actions.shift();
    const last = this.actions;
    const repeatedFailure = kind === "command" && exitCode !== undefined && exitCode !== 0 && last.length >= 3 && last.slice(-3).every(action => action === signature);
    const repeatedAction = last.length >= 4 && last.slice(-4).every(action => action === signature);
    const shortCycle = last.length === 6 && last[0] === last[2] && last[2] === last[4] && last[1] === last[3] && last[3] === last[5] && last[0] !== last[1];
    if (!repeatedFailure && !repeatedAction && !shortCycle) return false;
    let current: ProjectSnapshot;
    try { current = snapshotProject(this.projectPath); }
    catch { this.reset(); return false; }
    if (current.size >= 5000) { this.reset(); return false; }
    if (changedProjectFiles(this.baseline, current).length) {
      this.actions = [signature];
      this.baseline = current;
      return false;
    }
    return true;
  }
}
