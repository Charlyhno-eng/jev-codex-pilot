const ORANGE = "\x1b[38;5;208m";
const VIOLET = "\x1b[38;5;141m";
const RESET = "\x1b[0m";

/** Writes a JEV event to the backend terminal. */
export function logJev(message: string) {
  process.stdout.write(`${ORANGE}[JEV] ${message}${RESET}\n`);
}

/** Writes a JEV error to the backend terminal. */
export function logJevError(message: string) {
  process.stderr.write(`${ORANGE}[JEV] ${message}${RESET}\n`);
}

/** Writes a Codex session pause or resumption to the backend terminal. */
export function logSession(message: string) {
  process.stdout.write(`${VIOLET}[JEV] ${message}${RESET}\n`);
}
