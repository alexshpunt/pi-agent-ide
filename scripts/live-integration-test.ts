#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const usage = `Usage:
  pnpm test:integration:live -- <test-file> [options]
  pnpm test:integration:live:test -- <test-file> <test-name> [options]

Options:
  --stream-profile <name>  Streaming profile (default: gpt-5.6-sol-xhigh)
  --pause-ms <number>      Delay between repeated runs (default: 1000)
  --once                   Run once instead of repeating
  --help                   Show this help
`;

const commandArguments = process.argv.slice(2);
if (commandArguments[0] === "--") {
  commandArguments.shift();
}

const namedTest = commandArguments[0] === "--named-test";
if (namedTest) {
  commandArguments.shift();
}

const testFile = commandArguments.shift();
if (testFile === "--help" || testFile === "-h") {
  process.stdout.write(usage);
  process.exit(0);
}

const optionStart = commandArguments.findIndex((argument) => argument.startsWith("--"));
const testNameParts = namedTest
  ? optionStart === -1
    ? commandArguments
    : commandArguments.slice(0, optionStart)
  : [];
const options = namedTest
  ? optionStart === -1
    ? []
    : commandArguments.slice(optionStart)
  : commandArguments;
const testName = testNameParts.join(" ");

if (!testFile || (namedTest && !testName)) {
  process.stderr.write(usage);
  process.exit(1);
}

const liveOptions: string[] = [];
if (!options.includes("--stream-profile") && !options.includes("--delay-ms")) {
  liveOptions.push("--stream-profile", "gpt-5.6-sol-xhigh");
}
if (!options.includes("--pause-ms")) {
  liveOptions.push("--pause-ms", "1000");
}
liveOptions.push(...options);

const vitestArguments = ["vitest", "run", testFile];
if (namedTest) {
  vitestArguments.push("-t", testName);
}
vitestArguments.push("--config", "vitest.integration.config.mjs");

const result = spawnSync(
  "pnpm",
  ["exec", "pi-test", "live", ...liveOptions, "--", ...vitestArguments],
  { stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
