const BLUE = "\x1b[38;5;33m";
const WHITE = "\x1b[1;97m";
const GREEN = "\x1b[1;32m";
const RED = "\x1b[31m";
const VIOLET = "\x1b[38;5;141m";
const RESET = "\x1b[0m";

/** Writes a JEV event to the backend terminal. */
export function logJev(message: string) {
  process.stdout.write(`${BLUE}[JEV]${RESET} ${message}\n`);
}

/** Writes a JEV error to the backend terminal. */
export function logJevError(message: string) {
  process.stderr.write(`${BLUE}[JEV]${RESET} ${RED}${message}${RESET}\n`);
}

/** Writes a successfully applied JEV setting with a clear before and after value. */
export function logJevApplied(change: string, detail = "") {
  const suffix = detail ? ` ${detail}` : "";
  process.stdout.write(`${BLUE}[JEV]${RESET} ${WHITE}${change}${RESET} ${GREEN}✓ APPLIED${RESET}${suffix}\n`);
}

/** Writes a Codex session pause or resumption to the backend terminal. */
export function logSession(message: string) {
  process.stdout.write(`${BLUE}[JEV]${RESET} ${VIOLET}${message}${RESET}\n`);
}
