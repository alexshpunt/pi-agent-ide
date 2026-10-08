import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_EXTENSIONS } from "#src/composite/builtin-extensions.js";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

const root = findRepositoryRoot(import.meta.url);
const output = path.resolve(root, process.argv[2] ?? ".tmp/linear/LPT-149/capability-inventory.md");
const builtinRows: Readonly<Record<string, string>> = {
  "ide.core": "M16 M17 M24 M25",
  "ide.tips": "M24 M25",
  "ide.doctor": "M24 M25",
  "ide.languages": "M24",
  "read.core": "M02 M03 M04 M05 M06 M18 M25",
  "ide.documentation": "M25",
  "read.filesystem": "M02 M03 M04 M06 M07 M08 M10",
  "read.ssh": "M01 M02 M03 M04 M05 M06 M07 M08 M09 M10 M11 M12",
  "read.filesystem.jq": "M05",
  "read.filesystem.image": "M04",
  "read.filesystem.pdf": "M04",
  "read.filesystem.text": "M02 M04",
  "read.web": "M23",
  "read.web.html": "M23",
  "read.web.image": "M23",
  "read.web.pdf": "M23",
  "read.web.text": "M23",
  "search.core": "M07 M08 M14 M15 M19 M20 M23 M25",
  "search.text": "M07 M08",
  "editor.renderer": "M09 M10 M11 M12 M18 M25",
  "editor.core": "M06 M08 M09 M10 M11 M12 M18 M25",
  "editor.anchor.constant": "M06 M09",
  "editor.anchor.line-hash": "M06 M09",
  "editor.anchor.exact": "M06 M09",
  "editor.stale-anchor": "M06 M09",
  "ide.ast": "M06 M08 M14",
  "ide.formatter": "M17 M24",
  "ide.lint": "M16 M17 M24",
  "ide.changes": "M12 M13",
  "ide.lsp": "M15 M16 M24",
  "ide.processes": "M19 M20 M21 M25",
  "ide.vision": "M20 M22 M23",
  "ide.debugger": "M21 M24",
  "ide.terminal": "M19 M20 M25",
  "ide.diagnostics": "M16 M25",
};
const editor = "src/extensions/pi-agent-text-editor/src/core";
const tools: readonly (readonly [string, string, string])[] = [
  ["read", "M02 M03 M04 M05 M06 M18 M25", "src/extensions/pi-agent-read/src/core/extension.ts"],
  ["search", "M07 M08 M14 M15 M19 M20 M23", "src/extensions/pi-agent-search/src/core/extension.ts"],
  ["diff", "M06", `${editor}/diff-tool.ts`],
  ["select", "M06 M08 M14 M25", "src/plugins/pi-agent-ide-ast/src/extension.ts"],
  [
    "write / replace / insert / delete / copy / move",
    "M06 M08 M09 M10 M18",
    `${editor}/extension.ts`,
  ],
  ["undo", "M12 M13", "src/plugins/pi-agent-ide-changes/src/tool-text-undo.ts"],
  ["apply", "M11 M12 M13 M18 M19 M21", `${editor}/apply/tool.ts`],
  ["flush (native Codemode only)", "M09 M11", `${editor}/native-text-edit-batch.ts`],
  [
    "stage / unstage (deferred)",
    "M13",
    "src/plugins/pi-agent-ide-changes/src/tool-index-change.ts",
  ],
  ["debug (deferred)", "M21", "src/plugins/pi-agent-ide-debugger/index.ts"],
  [
    "bash (Linux) / powershell (Windows)",
    "M19 M20",
    "src/plugins/pi-agent-ide-terminal/src/tools.ts",
  ],
  [
    "edit (withdrawn host tool, not an execution capability)",
    "M09 M25",
    `${editor}/builtin-edit.ts`,
  ],
];
const protocols: Readonly<Record<string, string>> = {
  "pi-agent-ide": "M16 M17 M24 M25",
  "pi-agent-ide-tips": "M24 M25",
  "pi-agent-ide-doctor": "M24 M25",
  "pi-agent-ide-documentation": "M25",
  "pi-agent-resource/content-conversion": "M04 M05 M23 M25",
  "pi-agent-read": "M03 M04 M05 M06 M18 M25",
  "pi-agent-search": "M07 M08 M14 M15 M19 M20 M23 M25",
  "pi-agent-text-editor": "M06 M08 M09 M10 M11 M12 M18 M25",
};
const publicApis: Readonly<Record<string, string>> = {
  "./api/code-view": "M06 M14 M25",
  "./api/connect-plugin": "M16 M17 M24 M25",
  "./api/plugin-protocol": "M16 M17 M24 M25",
  "./api/toolchain": "M16 M17 M24",
  "./api/tool-config": "M16 M17 M24",
  "./api/tool-catalog": "M16 M17 M24",
  "./api/tips": "M24 M25",
  "./api/connect-tip-provider": "M24 M25",
  "./api/doctor": "M24 M25",
  "./api/documentation": "M25",
  "./api/connect-doctor-plugin": "M24 M25",
  "./api/hooks": "M18",
  "./api/path-identity": "M01 M03 M10 M15 M19 M20 M21 M22 M23",
  "./api/read": "M02 M03 M04 M05 M06 M18 M25",
  "./api/resource": "M02 M03 M04 M05 M06 M08 M09 M10 M11 M12 M25",
  "./api/search": "M07 M08 M14 M15 M19 M20 M23 M25",
  "./api/text": "M06 M08 M09 M14",
  "./api/text-editor": "M06 M08 M09 M10 M11 M12 M18 M25",
};
const surfaces: readonly (readonly [string, string, string])[] = [
  [
    "file paths, file:, directories, ssh://target/path",
    "M01 M02 M03 M04 M24",
    "src/backend/resource-resolver.ts",
  ],
  ["raw: (original bytes)", "M03 M04 M18", "src/backend/registration.ts"],
  [
    "Original file bytes from the same acquisition (ResourceBase.sourceBytes)",
    "M02 M04 M05 M06 M08 M25",
    "packages/pi-agent-resource/src/resource.ts",
  ],
  [
    "Physical source text before conversion/views and exact Read output authority",
    "M02 M04 M05 M06 M08 M25",
    "src/extensions/pi-agent-read/src/core/tools/read/result-target.ts",
  ],
  ["HTTP(S), web:ssh://target/URL", "M23", "src/backend/web-registration.ts"],
  ["docs: / docs:id and lazy guides", "M25", "src/documentation/extension.ts"],
  ["ast:, scopes, symbol:, graph:, symbols:", "M06 M08 M14 M15", "src/backend/lsp-registration.ts"],
  ["diagnostics: and diagnostics view", "M16", "src/plugins/pi-agent-ide-diagnostics/index.ts"],
  ["process: / process:ssh://target/PID", "M20", "src/backend/vision-registration.ts"],
  ["window: / display: with target ownership", "M22", "src/backend/vision-registration.ts"],
  [
    "shell: (Read/Search/input/keys/delete/image/sequence)",
    "M19 M20",
    "src/plugins/pi-agent-ide-terminal/index.ts",
  ],
  [
    "debug: (state/source/breakpoints/control/evaluation/delete)",
    "M21",
    "src/backend/debugger-registration.ts",
  ],
  [
    "SEARCH# / RESULT# typed snapshots and sparse ranges",
    "M06 M08 M09 M11 M14 M15",
    "packages/pi-agent-resource/src/result-targets.ts",
  ],
  ["CHANGE# and changes view", "M13", "src/backend/git-registration.ts"],
  ["APPLY# / last undo receipts", "M12", `${editor}/apply/undo-runtime.ts`],
  [
    "Mutation output targets: exact resulting text, destination-only transfers, restored presence/absence",
    "M06 M08 M09 M10 M12 M18 M25",
    `${editor}/mutation-result-targets.ts`,
  ],
  [
    "Pending native result reservation, confirmed publication and cancelled authority",
    "M08 M09 M11 M12 M25",
    `${editor}/native-text-edit-batch.ts`,
  ],
  [
    "temp: continuation, bounded windows and native bytes/images",
    "M03 M04 M06 M25",
    "src/extensions/pi-agent-read/src/core/extension.ts",
  ],
  [
    "jq:filter view",
    "M05",
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-jq/index.ts",
  ],
  ["anchors, ast, breakpoints views", "M06 M14 M21", "src/composite/builtin-extensions.ts"],
  [
    "image/sequence: region, scale, duration, interval, grids",
    "M04 M19 M22 M23",
    "src/backend/vision-registration.ts",
  ],
  ["BeforeRead, BeforeEdit, AfterEdit", "M18", "src/api/hooks.ts"],
  [
    "Read resolver/guard/processor/converter registrations",
    "M03 M04 M05 M18 M25",
    "src/extensions/pi-agent-read/src/api/plugin-protocol.ts",
  ],
  [
    "Search resolver and result-resource registrations",
    "M07 M08 M14 M15 M19 M20 M23 M25",
    "src/extensions/pi-agent-search/src/api/plugin-protocol.ts",
  ],
  [
    "Editor resolvers, anchors, file access, mutation guards/tools, script index operations, presenters, renderers, final completion",
    "M06 M08 M09 M10 M11 M12 M13 M18 M25",
    "src/extensions/pi-agent-text-editor/src/api/plugin-protocol.ts",
  ],
  [
    "IDE tools, revision-bound diagnostic sources/readers",
    "M16 M17 M24 M25",
    "src/api/plugin-protocol.ts",
  ],
  [
    "Shared process providers and UI: discovery is not control",
    "M19 M20 M21 M25",
    "src/plugins/pi-agent-ide-processes/src/registry.ts",
  ],
  [
    "Full / Compact / Disabled UI, passive tips, enabled module loading",
    "M24 M25",
    "src/composite/selection.ts",
  ],
];

const catalog = await readFile(path.join(root, "src/composite/builtin-extensions.ts"), "utf8");
const sources = new Map(
  [...catalog.matchAll(/builtin\(\s*"([^"]+)",[\s\S]*?import\("#src\/([^"]+)"\)/gu)].map(
    (match) => [required(match[1]), `src/${required(match[2]).replace(/\.js$/u, ".ts")}`],
  ),
);
assertCoverage(
  "built-ins",
  BUILTIN_EXTENSIONS.map((item) => item.id),
  builtinRows,
);
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
  exports: Record<string, { default: string }>;
};
assertCoverage("public entry points", Object.keys(manifest.exports), publicApis);
const lines = [
  "# SSH capability inventory",
  "",
  "Generated by scripts/audit-ssh-capabilities.ts from the task checkout. This maps implemented surfaces to the accepted M01–M25 rows; it does not claim that an existing file or test proves a passing contract.",
  "",
  "New built-in IDs, public entry points and declared plugin protocols fail this audit until mapped. Native tool factories and dynamic registrations are linked below, not inferred from tool-name string searches. Runtime/provider tests and live evidence remain separate.",
  "",
  "## Built-in registration order",
  "",
  "| ID | Rows | Source | Dependencies |",
  "| -- | -- | -- | -- |",
];
for (const item of BUILTIN_EXTENSIONS) {
  const source = sources.get(item.id);
  if (source === undefined) throw new Error(`No catalog loader for ${item.id}`);
  await assertFile(source);
  lines.push(
    `| ${item.id} | ${builtinRows[item.id]} | ${source} | ${item.dependencies.join(", ")} |`,
  );
}
lines.push(
  "",
  "## Native tools",
  "",
  "| Tool | Rows | Registration authority |",
  "| -- | -- | -- |",
);
for (const [name, rows, source] of tools) {
  await assertFile(source);
  lines.push(`| ${name} | ${rows} | ${source} |`);
}
lines.push(
  "",
  "## Public plugin protocols",
  "",
  "| Protocol | Rows | Declaration |",
  "| -- | -- | -- |",
);
const discoveredProtocols = new Set<string>();
for (const file of [...(await files("src")), ...(await files("packages"))]) {
  const text = await readFile(path.join(root, file), "utf8");
  for (const match of text.matchAll(/export const [A-Z_]*PROTOCOL\s*=\s*"([^"]+)"/gu)) {
    const protocol = required(match[1]);
    if (protocols[protocol] === undefined)
      throw new Error(`Unmapped protocol ${protocol} in ${file}`);
    discoveredProtocols.add(protocol);
    lines.push(`| ${protocol} | ${protocols[protocol]} | ${file} |`);
  }
}
assertCoverage("protocols", [...discoveredProtocols], protocols);
lines.push(
  "",
  "## Public package entry points",
  "",
  "| API | Rows | Authority |",
  "| -- | -- | -- |",
);
for (const [name, entry] of Object.entries(manifest.exports)) {
  await assertFile(entry.default);
  lines.push(`| ${name} | ${publicApis[name]} | ${entry.default} |`);
}
lines.push(
  "",
  "## Resource protocols, views and hooks",
  "",
  "| Surface | Rows | Authority |",
  "| -- | -- | -- |",
);
for (const [name, rows, source] of surfaces) {
  await assertFile(source);
  lines.push(`| ${name} | ${rows} | ${source} |`);
}
lines.push(
  "",
  "## Select and composed source results",
  "",
  "This checkout registers Select through the AST Read plugin. Strict text boundaries, source-local geometry, AST constructs/parts/navigation and argument/parameter extents map to M06/M08/M14/M25. tests/integration/ssh-select.integration.test.ts and ssh-lsp-select.integration.test.ts exercise ordinary and native composition. The continuation workpad records the current live SSH proof with installed TypeScript language server 5.3.0, canonical source labels, strict scopes and actionable boundary refusal. Those results are separate from this mechanical map.",
  "",
  "tests/integration/ssh-result-mutations.integration.test.ts, native-mutation-targets.integration.test.ts and ssh-restored-targets.integration.test.ts cover saved output authority, pending publication, cancellation and restored absence. The live workpad also records a retained pre-upgrade undo owner that restored bytes but did not report confirmed source states; that result correctly returned no editable target. Do not treat that mixed-version observation as a fresh-owner state verification.",
  "",
  "## Physical and derived Read output",
  "",
  "Filesystem resolvers retain original bytes from the same read before converters run. Read passes decoded sourceText to presenters and target registration. Physical source authority requires the retained original snapshot. jq clears that snapshot even when its output matches the file; converted PDF text and listings remain read-only. jq module syntax is rejected, including metadata search paths and modulemeta in string interpolation. This public code contract maps ResourceBase.sourceBytes, ReadPipelineContext.sourceText and TextPresentationContext.sourceText to M02/M04/M05/M06/M08/M25.",
  "",
  "tests/integration/ssh-read-views.integration.test.ts checks ordinary and native byte-detected media, JSONL transforms, physical anchors, permissions, continuation and original-file preservation. The workpad separately records loaded live proof and the terminal image-protocol boundary. Do not infer passing behavior from these file paths.",
  "",
  "## Evidence and completion gates",
  "",
  "The accepted task is the intent authority. The linked workpad records actual native/ordinary/live outcomes, cleanup and TUI boundaries. The separate agent evaluation document records the paired model sample and unchanged historical scores. None of those replaces an explicit per-row acceptance result.",
  "",
  "All M01–M25 rows still need their final result/evidence reconciliation. Complete Linux debugger recipe positives and conditional policy boundaries, loading-order/disabled-startup coverage and all three TUI modes must be checked before acceptance. An optional dependency skip is not parity. The image renderer's agreed terminal protocol boundary is not human pixel acceptance.",
  "",
);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, lines.join("\n"), "utf8");
console.log(
  `Mapped ${BUILTIN_EXTENSIONS.length} built-ins, ${Object.keys(publicApis).length} public APIs and ${discoveredProtocols.size} protocols: ${output}`,
);

function required(value: string | undefined): string {
  if (value === undefined) throw new Error("Incomplete inventory source match");
  return value;
}

function assertCoverage(
  label: string,
  actual: readonly string[],
  expected: Readonly<Record<string, string>>,
): void {
  const missing = actual.filter((name) => expected[name] === undefined);
  const stale = Object.keys(expected).filter((name) => !actual.includes(name));
  if (missing.length > 0 || stale.length > 0)
    throw new Error(`${label}: unmapped=${missing.join(",")} stale=${stale.join(",")}`);
}

async function assertFile(file: string): Promise<void> {
  await readFile(path.join(root, file));
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".tmp") continue;
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...(await files(file)));
    else if (entry.isFile() && file.endsWith(".ts") && !file.endsWith(".test.ts"))
      result.push(file);
  }
  return result.sort();
}
