/** Formats a value as a readable integer. */
export function formatNumber(value?: number) { return value === undefined ? "—" : new Intl.NumberFormat().format(value); }
/** Formats a value as a compact US dollar amount. */
export function formatUsd(value: number) { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(value); }
/** Formats a Codex reasoning level for display. */
export function reasoningLabel(value: string) { return value === "xhigh" ? "Extra high" : value; }
/** Formats the detected verification level. */
export function verificationLabel(value: string) { return value === "functional_verified" ? "Functionally verified" : value === "tests_passed" ? "Automated tests passed" : value === "build_only" ? "Build only · behavior unverified" : "No verification detected"; }
