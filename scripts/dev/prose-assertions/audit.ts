import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finding(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.filename !== "string" ||
    typeof value.message !== "string" ||
    value.severity !== "warning" ||
    !Array.isArray(value.labels)
  ) {
    throw new Error("Unexpected lint diagnostic; inspect the raw JSON before using this report.");
  }
  const label: unknown = value.labels[0];
  if (
    !isRecord(label) ||
    !isRecord(label.span) ||
    typeof label.span.line !== "number" ||
    typeof label.span.column !== "number" ||
    typeof label.span.offset !== "number" ||
    typeof label.span.length !== "number"
  ) {
    throw new Error("Lint diagnostic has no source range.");
  }
  return {
    file: value.filename,
    line: label.span.line,
    column: label.span.column,
    offset: label.span.offset,
    length: label.span.length,
    kind: value.message.startsWith("Prompt/") ? "prompt/document" : "wording candidate",
  };
}

const root = findRepositoryRoot(import.meta.url);
const output = path.join(root, ".tmp/prose-assertions");
const config = "scripts/dev/prose-assertions/audit.config.ts";
const command = `pnpm exec oxlint --config ${config} --format json .`;
const { stdout, stderr } = await promisify(execFile)(
  "pnpm",
  ["exec", "oxlint", "--config", config, "--format", "json", "."],
  {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  },
);
if (stderr.trim() !== "") throw new Error(stderr);
const data: unknown = JSON.parse(stdout);
if (
  !isRecord(data) ||
  !Array.isArray(data.diagnostics) ||
  typeof data.number_of_files !== "number"
) {
  throw new Error("Oxlint did not return a complete audit result.");
}
const findings = data.diagnostics
  .map(finding)
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
const files = new Set(findings.map((entry) => entry.file));
const prompts = findings.filter((entry) => entry.kind === "prompt/document");
const lines = [
  "# Prose assertion audit",
  "",
  `Command: \`${command}\``,
  "",
  `Oxlint visited ${data.number_of_files} files. The rule only inspects test/spec files.`,
  `${findings.length} candidate assertions in ${files.size} test files: ${prompts.length} prompt/document candidates and ${findings.length - prompts.length} broader wording candidates.`,
  "",
  "These are candidates, not proven defects. Source names and prose heuristics can misclassify technical syntax, fixture text, metadata, and error-category checks. No tests were changed and default lint is not affected.",
  "",
  "## Prompt/document candidates",
  "",
  ...prompts.map((entry) => `- \`${entry.file}:${entry.line}:${entry.column}\``),
  "",
  "## All findings",
  "",
];
const sources = new Map<string, Buffer>();
for (const entry of findings) {
  let source = sources.get(entry.file);
  if (source === undefined) {
    source = await readFile(path.join(root, entry.file));
    sources.set(entry.file, source);
  }
  const snippet = source.subarray(entry.offset, entry.offset + entry.length).toString("utf8");
  const fence = "`".repeat(
    Math.max(4, ...(snippet.match(/`+/gu) ?? []).map((run) => run.length + 1)),
  );
  lines.push(
    `### ${entry.file}:${entry.line}:${entry.column}`,
    "",
    `Kind: ${entry.kind}`,
    "",
    `${fence}ts`,
    snippet,
    fence,
    "",
  );
}
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(path.join(output, "scan.json"), stdout),
  writeFile(path.join(output, "findings.md"), lines.join("\n")),
]);
console.log(
  `${findings.length} candidates in ${files.size} tests: ${prompts.length} prompt/document, ${findings.length - prompts.length} broader wording.`,
);
console.log("Not enabled in default lint. Review the findings before choosing enforcement.");
console.log("Full report: .tmp/prose-assertions/findings.md");
console.log("Raw diagnostics: .tmp/prose-assertions/scan.json");
