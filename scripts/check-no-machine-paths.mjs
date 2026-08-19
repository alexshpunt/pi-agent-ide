#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
const forbidden = [
    { label: "root home path", pattern: new RegExp(`/${["ro", "ot"].join("")}/`, "u") },
    {
        label: "personal home path",
        pattern: new RegExp(`/home/(?:${["to", "bi"].join("")}|${["circle", "ci"].join("")})/`, "u"),
    },
    { label: "local file dependency", pattern: new RegExp(`\\b${["fi", "le"].join("")}:(?:/(?!/)|\\.{1,2}/)`, "u") },
    { label: "current checkout path", pattern: new RegExp(escapeRegExp(process.cwd()), "u") },
];
const failures = [];

for (const file of files)
{
    let content;

    try
    {
        content = readFileSync(file, "utf8");
    }
    catch
    {
        continue;
    }

    for (const rule of forbidden)
    {
        if (rule.pattern.test(content)) failures.push(`${file}: ${rule.label}`);
    }
}

if (failures.length > 0)
{
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exit(1);
}

process.stdout.write(`Checked ${files.length} repository files for machine-specific paths.\n`);

function escapeRegExp(value)
{
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
