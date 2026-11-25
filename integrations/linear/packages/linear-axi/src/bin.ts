#!/usr/bin/env node
import { main } from "./cli.ts";
import { configureNetwork } from "./lib/network.ts";
import { valueText } from "./lib/value-text.ts";

configureNetwork();
main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : valueText(error);
  process.stdout.write(`error: ${message}\n`);
  process.stdout.write("help[1]: Run `linear-axi --help`\n");
  process.exitCode = 1;
});
