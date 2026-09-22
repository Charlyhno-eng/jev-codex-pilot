import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Holds the shared JEV data directory for one API process at a time. */
export async function acquireApiInstance(dataDirectory: string): Promise<() => void> {
  mkdirSync(dataDirectory, { recursive: true });
  const file = join(dataDirectory, "api.lock");
  const token = randomUUID();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const descriptor = openSync(file, "wx", 0o600);
      try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); }
      finally { closeSync(descriptor); }
      const release = () => {
        try {
          const owner = JSON.parse(readFileSync(file, "utf8")) as { token?: string };
          if (owner.token === token) unlinkSync(file);
        } catch { /* A crashed or replaced lock is left for recovery. */ }
      };
      process.once("exit", release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; token?: string };
        if (Number.isInteger(owner.pid) && owner.pid && owner.pid !== process.pid) {
          try { process.kill(owner.pid, 0); }
          catch (checkError) {
            if ((checkError as NodeJS.ErrnoException).code === "ESRCH") {
              const current = JSON.parse(readFileSync(file, "utf8")) as { token?: string };
              if (current.token === owner.token) unlinkSync(file);
              continue;
            }
          }
        }
      } catch { /* Wait for an in-progress lock write. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Another JEV API process is using ${dataDirectory}. Stop it before starting a second server.`);
}
