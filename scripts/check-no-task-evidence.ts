#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--staged")) {
  throw new Error("Use --staged for pre-commit, or no arguments to check the Git index.");
}
const staged = args[0] === "--staged";
const files = execFileSync(
  "git",
  staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
    : ["ls-files", "--cached", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const artifactDirectories = new Set(["evidence", "evidences", ".tmp", ".agents"]);
const forbidden = files.filter((file) =>
  file.split("/").some((segment) => artifactDirectories.has(segment)),
);

if (forbidden.length > 0) {
  process.stderr.write(
    `Task run artifacts must not be committed. Attach retained results to the corresponding Task.\n${forbidden.map((file) => JSON.stringify(file)).join("\n")}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `Checked ${files.length} ${staged ? "staged" : "indexed"} files for task run artifacts.\n`,
);
