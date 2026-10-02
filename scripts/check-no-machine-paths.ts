#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    encoding: "utf8",
  },
)
  .split("\0")
  .filter(Boolean);
const forbidden: {
  readonly label: string;
  readonly pattern: RegExp;
  readonly allowedFiles?: readonly string[];
}[] = [
  {
    label: "root home path",
    pattern: new RegExp(`/${["ro", "ot"].join("")}/`, "u"),
    // This local Pi setting intentionally excludes the global checkout.
    allowedFiles: [".pi/settings.json"],
  },
  {
    label: "personal home path",
    pattern: new RegExp(`/home/(?:${["to", "bi"].join("")}|${["circle", "ci"].join("")})/`, "u"),
  },
  {
    label: "local file dependency",
    pattern: new RegExp(`\\b${["fi", "le"].join("")}:(?:/(?!/)|\\.{1,2}/)`, "u"),
    // These test values are resource keys, not package dependencies.
    allowedFiles: ["packages/pi-agent-resource/src/resource-scheduler.test.ts"],
  },
  { label: "current checkout path", pattern: new RegExp(escapeRegExp(process.cwd()), "u") },
];
const failures: string[] = [];
const forbiddenRepositoryPrefixes = [".pi/skills/"];
const projectSkillPrefixes = [
  ".pi/skills/create-issue/",
  ".pi/skills/design-read-views/",
  ".pi/skills/design-terminal-ui/",
  ".pi/skills/export-agent-interface/",
  ".pi/skills/publish-pi-agent-ide/",
  ".pi/skills/testing-pi-agent-ide/",
  ".pi/skills/take-task/",
  ".pi/skills/write-agent-tool-prompts/",
];

for (const file of files) {
  if (
    forbiddenRepositoryPrefixes.some((prefix) => file.startsWith(prefix)) &&
    !projectSkillPrefixes.some((prefix) => file.startsWith(prefix))
  ) {
    failures.push(`${file}: private repository path`);
  }
  let content: string;

  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const rule of forbidden) {
    if (!rule.allowedFiles?.includes(file) && rule.pattern.test(content)) {
      failures.push(`${file}: ${rule.label}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Checked ${files.length} repository files for machine-specific paths.\n`);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
