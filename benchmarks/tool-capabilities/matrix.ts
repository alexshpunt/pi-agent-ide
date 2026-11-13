import type { Capability } from "./validation.ts";

// This declared inventory is reviewed separately from executable cases.
// SDK capability-loader rendering retains model results and adds no paid operation.
// Native cards and receipt visibility have deterministic real-Pi coverage.
const groups: [string[], string[]][] = [
  [
    ["standalone.discovery", "standalone.read-search-edit", "standalone.resource-bounds"],
    ["standalone-resource-host"],
  ],
  [["edit.copy-binary", "edit.move-binary", "compose.binary-copy-refusal"], ["binary-copy-move"]],
  [["read.text", "read.directory", "read.raw", "read.paging"], ["read-text"]],
  [
    ["read.failure", "read.provider-failure-ownership"],
    ["read-error-direct", "read-error-codemode"],
  ],
  [["codemode.failed-call-null", "codemode.failed-call-summary"], ["read-error-codemode"]],
  [["read.jq", "read.jq-paging"], ["read-jq"]],
  [["read.jq-bounded-input"], ["read-jq-bounded-input"]],
  [["read.ssh-guide"], ["ssh-guide"]],
  [["read.ide-settings", "search.ide-settings"], ["ide-settings-catalog"]],
  [
    ["search.docs-all", "search.docs-one", "search.docs-flags", "search.docs-readonly"],
    ["docs-search"],
  ],
  [
    ["search.docs-limit", "search.docs-empty", "search.docs-unknown", "search.docs-bare"],
    ["docs-search-status"],
  ],
  [["compose.read-search", "compose.search-replace"], ["read-search-replace"]],
  // Pair actual native/alias TUI frames; execution alone cannot establish renderer parity.
  [["compose.codemode-child-result"], ["codemode-child-presentation"]],
  [["search.script-facts", "compose.search-script-result"], ["search-script-facts"]],
  [["search.script-match-list", "compose.search-match-id"], ["search-script-match-ids"]],
  // Reuse the same byte/provenance contracts across native and explicitly selected connector runs.
  [["compose.provider-reference-roundtrip"], ["read-search-replace"]],
  [["compose.provider-cross-call-reference"], ["codemode-store"]],
  [["edit.large-replace-payload"], ["streamed-replace"]],
  [
    [
      "edit.issued-result-streaming",
      "edit.reject-result-anchor-combination",
      "compose.native-provider-auth",
    ],
    ["issued-result-edit"],
  ],
  [["compose.scoped-boolean"], ["read-scoped-boolean"]],
  [["compose.search-issued-scope"], ["search-issued-scope"]],
  [["compose.batch-insert-search"], ["search-line-batch-insert"]],
  [["compose.batch-replace-search"], ["selection-batch-replace"]],
  [["edit.replace-search-anchor-list"], ["replace-search-anchor-list"]],
  [["edit.already-done-targets"], ["replace-already-done-anchor-list"]],
  [["edit.insert-search-anchor-list"], ["insert-search-anchor-list"]],
  [["edit.search-anchor-list-unusable"], ["replace-search-anchor-list-unusable"]],
  ...["delete", "insert"].map((operation): [string[], string[]] => [
    [`edit.search-line-batch-${operation}`],
    [`search-line-batch-${operation}`],
  ]),
  ...["replace", "delete", "insert"].map((operation): [string[], string[]] => [
    [`edit.selection-batch-${operation}`],
    [`selection-batch-${operation}`],
  ]),
  [["compose.read-window-delete"], ["read-window-delete"]],
  [["compose.read-window-insert"], ["read-window-insert"]],
  [["edit.grouped-file-count"], ["grouped-replace-file-count"]],
  [["edit.stale-insert-feedback", "edit.bounded-stale-feedback"], ["stale-insert-recovery"]],
  [["edit.repeated-line-anchor-shift"], ["repeated-line-anchor-after-shift"]],
  [["edit.repeated-line-anchor-block-change"], ["repeated-line-anchor-after-block-delete"]],
  [
    ["read.overview-source", "compose.overview-search", "compose.overview-window"],
    ["read-overview-search-lines", "read-overview-search-bytes"],
  ],
  [["compose.large-read-store-load"], ["read-large-store"]],
  [["codemode.read-exact-text"], ["read-large-json-script"]],
  [
    ["codemode.read-bytes", "codemode.read-entries", "codemode.read-path-list"],
    ["read-script-values"],
  ],
  [["search.text", "compose.search-insert", "edit.insert"], ["search-anchor-insert"]],
  [["search.boolean", "search.regex", "file_search.glob", "search.flags"], ["search-query"]],
  [["search.path-list", "file_search.path-list", "ast_search.path-list"], ["search-path-list"]],
  [
    ["file_search.script-paths", "file_search.script-limit", "compose.file-search-paths-read"],
    ["file-search-script-paths"],
  ],
  [["lsp_search.path-list"], ["lsp-path-list"]],
  [["search.literal-operators"], ["search-literal-operators"]],
  [
    // Engine switching is a settings-menu lifecycle, checked in real Pi rather than a model route.
    ["search.semantic", "search.semantic-scope-filters", "compose.semantic-read"],
    ["semantic-code-search"],
  ],
  [
    ["search.semantic-vera", "search.semantic-vera-scope-filters", "compose.semantic-vera-read"],
    ["semantic-code-search-vera"],
  ],
  [["search.semantic-vera-refresh"], ["semantic-vera-refresh"]],
  [["search.semantic-script-files"], ["semantic-script-files"]],
  [["search.multiline", "compose.search-multiline-replace"], ["search-multiline-between"]],
  [["read.anchors", "edit.replace-range"], ["read-anchor-replace"]],
  [["edit.replace-exact-range", "edit.leading-newline-range"], ["exact-range-replace"]],
  [["edit.delete-exact-range"], ["exact-range-delete"]],
  [["edit.copy-exact-range", "edit.copy-exact-destination"], ["exact-range-copy"]],
  [["edit.move-exact-range", "edit.move-exact-destination"], ["exact-range-move"]],
  [["edit.copy-source-range"], ["exact-range-copy", "selection-copy-move"]],
  [["edit.move-source-range"], ["exact-range-move", "selection-copy-move"]],
  [["edit.mixed-range-endpoints"], ["mixed-range-replace"]],
  [
    ["compose.search-range-endpoints"],
    ["exact-range-delete", "exact-range-copy", "exact-range-move"],
  ],
  [["edit.write", "edit.write-receipt", "compose.write-read"], ["write-read"]],
  [["edit.semantic-write-receipt"], ["semantic-write-receipts"]],
  // Optional safe error metadata does not change provider receipt effects or their data fields.
  // Rate-limit metadata transport has deterministic ResourceError/Read/Write coverage, not a paid route.
  [["compose.provider-structured-receipt"], ["semantic-script-receipts"]],
  // Local forwarding aliases may be deferred and absent from the initial catalogue. The alias
  // receipt case asks for discovery and requires the real native child; prompt deduplication is
  // checked separately by deterministic real-Pi loadout tests.
  [["compose.local-alias-structured-receipt"], ["semantic-local-alias-receipts"]],
  [["edit.write-failure-recovery", "compose.uncertain-write-read"], ["write-unknown-effects"]],
  [
    ["edit.write-canonicalized-snapshot", "compose.confirmed-write-readback"],
    ["write-confirmed-readback"],
  ],
  [["codemode.silent-write"], ["write-silent"]],
  [["edit.write-hook-feedback", "compose.write-hook-read"], ["write-hook-read"]],
  [["compose.write-large-read"], ["write-large-read"]],
  [
    ["edit.replace-exact", "compose.mutation-read", "compose.mutation-search"],
    ["replace-read-search"],
  ],
  [
    ["edit.insert-before", "edit.insert-spacing", "edit.insert-exact-boundaries"],
    ["insert-before"],
  ],
  [["edit.delete-selection", "compose.search-delete"], ["delete-selection"]],
  [["edit.delete-declaration"], ["delete-symbol"]],
  [["compose.symbol-read-delete"], ["read-symbol-delete"]],
  [["edit.reject-symbol-delete"], ["reject-symbol-delete"]],
  [
    ["edit.copy-file", "edit.move-file", "edit.delete-file", "edit.whole-file-omission"],
    ["file-copy-move-delete"],
  ],
  [["compose.file-delete-text-edit"], ["mixed-file-delete-text-edit"]],
  [["edit.move-effects"], ["move-unknown-effects"]],
  [
    [
      "edit.copy-directory",
      "edit.move-directory",
      "edit.copy-symlink",
      "edit.move-symlink",
      "edit.copy-merge-directory",
      "edit.move-replace-directory",
      "compose.object-transfer-refusal",
    ],
    ["directory-transfers"],
  ],
  [
    ["edit.transfer-refusal", "edit.move-policy-refusal", "edit.approval-headless-move"],
    ["directory-transfer-gates"],
  ],
  [["compose.approval-refusal-read"], ["delete-policy-gates", "directory-transfer-gates"]],
  [
    ["edit.approval-yolo-delete", "edit.approval-yolo-move", "compose.yolo-protected-target"],
    ["filesystem-yolo"],
  ],
  [
    ["edit.delete-directory", "edit.delete-symlink", "edit.delete-broken-symlink"],
    ["delete-objects"],
  ],
  [
    [
      "edit.delete-policy-refusal",
      "edit.delete-protected-path",
      "edit.delete-protected-root",
      "edit.approval-headless-delete",
    ],
    ["delete-policy-gates"],
  ],
  [
    [
      "edit.delete-temporary-defaults",
      "edit.delete-temporary-roots",
      "edit.delete-temporary-names",
    ],
    ["delete-temporary-defaults"],
  ],
  [["edit.delete-temporary-config", "edit.move-temporary-config"], ["delete-temporary-config"]],
  [
    ["edit.move-temporary-defaults", "edit.copy-temporary-directory"],
    ["move-temporary-directories"],
  ],
  [
    [
      "edit.copy-selection",
      "edit.move-selection",
      "compose.read-window-copy",
      "compose.read-window-move",
    ],
    ["selection-copy-move"],
  ],
  [
    ["edit.move-rollback"],
    [
      "move-rollback-restored",
      "move-rollback-target-failed",
      "move-rollback-target-failed-after-restore",
    ],
  ],
  [["compose.paired-sources-targets"], ["paired-copy"]],
  [["edit.copy-destination-recovery"], ["copy-destination-recovery"]],
  [["edit.move-empty"], ["move-empty"]],
  [["edit.move-zero-width", "compose.move-point-replace"], ["move-zero-width"]],
  [["read.diff", "compose.read-diff"], ["read-diff"]],
  [["read.diff-omission"], ["diff-omission"]],
  [["codemode.diff-complete"], ["diff-script-complete"]],
  [["edit.replace-line-endings"], ["replace-line-boundary-lf", "replace-line-boundary-crlf"]],
  [
    ["edit.exact-eof", "edit.delete-empty-replace"],
    ["exact-eof-lf", "exact-eof-crlf", "exact-eof-unterminated"],
  ],
  [
    ["codemode.parallel-edit-effects"],
    ["parallel-edit-effects-all", "parallel-edit-effects-allSettled"],
  ],
  [["edit.undo-last", "compose.mutation-undo"], ["undo-last"]],
  [
    [
      "git.changes",
      "git.stage",
      "git.stage-noop",
      "git.unstage",
      "git.undo-change",
      "discovery.git",
    ],
    ["git-stage-unstage-undo"],
  ],
  [["compose.search-narrow-result"], ["read-search-narrow"]],
  // Result-input paths accept the same file as a scalar or an array; both keep real reuse checks.
  [["read.ast", "search.ast", "compose.ast-capture-edit"], ["ast-capture-rename"]],
  [["ast_search.rule", "compose.ast-search-enclosing"], ["ast-search-enclosing"]],
  [["read.ast-view", "edit.scope-anchors"], ["read-ast-boundary"]],
  [["codemode.store-load", "compose.cross-call"], ["codemode-store"]],
  // Direct calls take the same object; the focused source-value cases cover them without a model.
  [["compose.value-id-source"], ["value-id-source"]],
  [["compose.stale-recovery", "read.reference-recovery"], ["stale-recovery"]],
  [["compose.result-selector-rejection"], ["result-selector-rejection"]],
  [
    [
      // Fresh-session follow-up operations exercise metadata activated by the first Bash call.
      // Schema publication and delayed-card ownership have deterministic integration coverage.
      "shell.execute",
      "shell.read",
      "shell.search",
      "shell.input",
      "compose.shell-first-use-input",
      "compose.shell-input-read",
      "compose.shell-keys-read",
      "shell.keys",
      "compose.shell-reference-after-input",
      "shell.file-authority-refusal",
      "shell.delete",
    ],
    ["shell-roundtrip"],
  ],
  [["shell.image", "shell.sequence"], ["shell-screen"]],
  // The process list sent after compaction has deterministic registry and live checks.
  [["shell.name", "shell.list", "shell.search-all", "shell.rename"], ["shell-catalog"]],
  // Scripts get Pi's bash fields; a non-zero exit is a value, so the Codemode result lists no failure.
  [["shell.script-value"], ["shell-script-value"]],
  [
    [
      "debug.create",
      "compose.debug-first-use-controls",
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
      "compose.debug-breakpoint-delete-read-session",
      "read.breakpoints",
    ],
    ["debug-controls"],
  ],
  [["debug.backend-vscode-refusal", "debug.backend-native"], ["debug-backend-fallback"]],
  [
    ["lsp.symbols", "lsp.references", "lsp.graph", "lsp.diagnostics", "read.diagnostics-view"],
    ["lsp-read"],
  ],
  [
    [
      "lsp.rename",
      "lsp.rename-cross-file",
      "lsp.rename-keeps-unrelated-names",
      "compose.symbol-read-rename",
    ],
    ["lsp-rename"],
  ],
  [["lsp.overload-selectors", "compose.symbol-overload-rename"], ["lsp-overload-rename"]],
  [["lsp.script-call-graph", "compose.lsp-caller-id"], ["lsp-calls-script-value"]],
  // The PDF route covers ordinary and recoverable documents; terminal silence is a separate check.
  [["read.image", "read.pdf"], ["read-media"]],
  [["compose.codemode-image-value"], ["codemode-image-value"]],
  [["compose.read-image-write"], ["read-image-write"]],
  [["write.json-text"], ["write-json-text"]],
  [["web.read", "web.search"], ["web-read-search"]],
];

/** Intended contracts and the cases that can establish them, not every tool permutation. */
export const capabilityMatrix: Capability[] = groups.flatMap(([ids, cases]) =>
  ids.map((id) => ({ id, cases })),
);
