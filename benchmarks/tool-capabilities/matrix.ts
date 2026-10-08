import type { Capability } from "./validation.ts";

// This declared inventory is reviewed separately from executable cases.
const groups: [string[], string[]][] = [
  [["edit.copy-binary", "edit.move-binary", "compose.binary-copy-refusal"], ["binary-copy-move"]],
  [["read.text", "read.directory", "read.raw", "read.paging"], ["read-text"]],
  [["read.jq"], ["read-jq"]],
  [["compose.read-search", "compose.search-replace"], ["read-search-replace"]],
  [["search.text", "compose.search-insert", "edit.insert"], ["search-anchor-insert"]],
  [["search.boolean", "search.regex", "search.files", "search.flags"], ["search-query"]],
  [["read.anchors", "edit.replace-range"], ["read-anchor-replace"]],
  [["edit.write", "compose.write-read"], ["write-read"]],
  [
    ["edit.replace-exact", "compose.mutation-read", "compose.mutation-search"],
    ["replace-read-search"],
  ],
  [["edit.insert-before", "edit.insert-spacing"], ["insert-before"]],
  [["edit.delete-selection", "compose.search-delete"], ["delete-selection"]],
  [["edit.copy-file", "edit.move-file", "edit.delete-file"], ["file-copy-move-delete"]],
  [
    ["edit.copy-selection", "edit.move-selection", "compose.select-copy", "compose.select-move"],
    ["selection-copy-move"],
  ],
  [["compose.paired-sources-targets"], ["paired-copy"]],
  [["read.diff", "compose.read-diff"], ["read-diff"]],
  [["edit.undo-last", "compose.mutation-undo"], ["undo-last"]],
  [
    ["git.changes", "git.stage", "git.unstage", "git.undo-change", "discovery.git"],
    ["git-stage-unstage-undo"],
  ],
  [
    ["compose.read-select", "compose.select-replace"],
    [
      "select-range",
      "select-lines",
      "select-between",
      "select-sliceText",
      "select-trim",
      "select-split",
      "select-columns",
    ],
  ],
  [["select.object", "select.part", "read.ast", "search.ast"], ["select-object-part"]],
  [["read.ast-view", "edit.scope-anchors"], ["read-ast-boundary"]],
  [["select.navigate"], ["select-navigate"]],
  [["select.elementExtent"], ["select-elementExtent"]],
  [["codemode.store-load", "compose.cross-call"], ["codemode-store"]],
  [["compose.stale-recovery", "read.reference-recovery"], ["stale-recovery"]],
  [
    [
      "shell.execute",
      "shell.read",
      "shell.search",
      "shell.input",
      "compose.shell-input-read",
      "compose.shell-keys-read",
      "shell.keys",
      "compose.shell-reference-after-input",
      "shell.file-authority-refusal",
      "shell.delete",
      "process.discovery",
      "process.read",
    ],
    ["shell-roundtrip"],
  ],
  [["shell.image", "shell.sequence"], ["shell-screen"]],
  [
    [
      "debug.create",
      "debug.read",
      "debug.breakpoints",
      "debug.start",
      "debug.evaluate",
      "debug.delete",
      "discovery.debug",
    ],
    ["debug-roundtrip"],
  ],
  [
    [
      "debug.step-into",
      "debug.step-over",
      "debug.step-out",
      "debug.continue",
      "debug.delete-breakpoint",
      "read.breakpoints",
    ],
    ["debug-controls"],
  ],
  [
    ["lsp.symbols", "lsp.references", "lsp.graph", "lsp.diagnostics", "read.diagnostics-view"],
    ["lsp-read"],
  ],
  [["lsp.rename", "compose.symbol-read-rename"], ["lsp-rename"]],
  [["read.image", "read.pdf"], ["read-media"]],
  [["web.read", "web.search", "web.image", "web.sequence"], ["web-read-search"]],
  [["vision.display", "vision.window", "vision.sequence"], ["vision-display-window"]],
];
for (const kind of [
  "range",
  "lines",
  "between",
  "sliceText",
  "trim",
  "split",
  "columns",
  "linesOf",
  "position",
  "within",
  "intersection",
  "difference",
  "merge",
])
  groups.push([[`select.${kind}`], [`select-${kind}`]]);

/** Intended contracts and the cases that can establish them, not every tool permutation. */
export const capabilityMatrix: Capability[] = groups.flatMap(([ids, cases]) =>
  ids.map((id) => ({ id, cases })),
);
