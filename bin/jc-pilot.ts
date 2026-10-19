#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = process.cwd();
const applicationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(applicationDirectory);
const { register } = await import("tsx/esm/api");
register();

const { main } = await import("../src/cli/main.ts");
await main(process.argv.slice(2), projectDirectory);
