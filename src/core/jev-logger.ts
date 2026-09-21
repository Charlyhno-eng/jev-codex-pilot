const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Writes a JEV event to the backend terminal. */
export function logJev(message: string) {
  process.stdout.write(`${RED}[JEV] ${message}${RESET}\n`);
}

/** Writes a JEV error to the backend terminal. */
export function logJevError(message: string) {
  process.stderr.write(`${RED}[JEV] ${message}${RESET}\n`);
}
