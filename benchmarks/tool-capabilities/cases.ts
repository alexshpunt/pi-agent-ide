import { pixelPng } from "./sandbox.ts";
import { parallelCalls } from "./prompts.ts";
import type { CapabilityCase, RouteStep } from "./validation.ts";

// Directory/symlink approval is a host UI policy, not an agent calling requirement.
const both = ["direct", "codemode"];
const reuse = (from: number, field: string | string[] = "path", kind = "result") => ({
  from,
  field,
  kind,
});
/**
 * A numbered Search `:match` reference of a direct call, or in Codemode the id of a match from a
 * Search value, which carries no numbered references.
 */
const matchReference = (index: number) =>
  new RegExp(`^(?:SEARCH#[A-F0-9]+:${String(index)}:match|RESULT#[a-f\\d-]{36})$`, "u");
const textFile = { "task.txt": "keep\nOLD\nlast\n" };
const deleteFixture = { "sentinel.txt": "KEEP\n", "tracked/data": "KEEP\n" };
const cases: CapabilityCase[] = [];

add(
  "codemode-tool-names",
  ["codemode.provider-tool-names"],
  'Use one native Codemode script to Read task.txt, Replace the literal OLD fragment with NEW, and pass the unchanged returned mutation value as the path argument to Read. Print both Read values. Then Write note.txt with exactly "saved\\n", run Bash with command "printf tool-name-probe", and print its output. Keep every other byte. Report the probe output and the final task.txt content.',
  [
    { tool: "read", args: { path: "task.txt" }, contains: "OLD", parentContains: "OLD" },
    { tool: "replace", args: { path: "task.txt" }, exactText: ["start"], after: [0] },
    { tool: "read", reuse: reuse(1), contains: "NEW", parentContains: "NEW" },
    { tool: "write", args: { path: "note.txt" } },
    { tool: "bash", contains: "tool-name-probe", parentContains: "tool-name-probe" },
  ],
  {
    modes: ["codemode"],
    expected: { "task.txt": "keep\nNEW\nlast\n", "note.txt": "saved\n" },
    answer: "tool-name-probe",
  },
);

for (const selection of ["numbered", "all"] as const) {
  add(
    `search-compaction-${selection}`,
    [`search.compaction-${selection}`],
    selection === "numbered"
      ? "Search task.txt for OLD with limit 1. The three identical lines are compacted. Repeat the same Search on task.txt with limit 3 to obtain all three individual references. Then Insert ADDED before each of those three lines using its own actual issued numbered SEARCH :line reference as path (before: true). Keep every other byte. Do not reuse the first reference for the other occurrences."
      : "Search task.txt for OLD with limit 1. The three identical lines are compacted. Use that completed Search's actual issued :all:line reference as path in one Insert call with text ADDED and before: true. Insert once before each OLD line and keep every other byte. Do not use the compact group's first numbered reference.",
    [
      { tool: "search", args: { path: "task.txt", query: "OLD", limit: 1 } },
      ...(selection === "numbered"
        ? [
            { tool: "search", args: { path: "task.txt", query: "OLD", limit: 3 }, after: [0] },
            ...[1, 2, 3].map((index): RouteStep => ({
              tool: "insert",
              args: { path: new RegExp(`^SEARCH#[A-F0-9]+:${index}:line$`, "u"), before: true },
              reuse: reuse(1),
            })),
          ]
        : [
            {
              tool: "insert",
              args: { path: /^SEARCH#[A-F0-9]+:all:line$/u, before: true },
              reuse: reuse(0),
            },
          ]),
    ],
    {
      modes: ["direct"],
      files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\nOLD\n" },
      expected: { "task.txt": "keep1\nADDED\nOLD\nkeep2\nADDED\nOLD\nkeep3\nADDED\nOLD\n" },
    },
  );
}
add(
  "missing-edit-selector-recovery",
  ["edit.missing-selector-recovery"],
  'First call insert on task.txt with text "added" and no anchor; it must fail without editing. Read task.txt, then retry insert with anchor "OLD" and the same text. Next call copy from task.txt to target.txt, passing the literal string "OLD" as start and omitting targetStart; it must fail without editing either file. Read target.txt and retry copy with targetStart "DEST". Keep all existing lines. Do not use whole-file operations or write. In Codemode, keep going after each refused call using the returned null and the failure summary.',
  [
    {
      tool: "insert",
      args: { path: "task.txt", anchor: undefined, text: /[\s\S]+/u },
      error: true,
      contains: "INVALID_REQUEST",
    },
    { tool: "read", args: { path: "task.txt" }, after: [0] },
    { tool: "insert", args: { path: "task.txt", anchor: "OLD", text: "added" }, after: [1] },
    {
      tool: "copy",
      args: { path: "task.txt", target: "target.txt", targetStart: undefined },
      exactText: ["start"],
      error: true,
      contains: "INVALID_REQUEST",
      after: [2],
    },
    { tool: "read", args: { path: "target.txt" }, after: [3] },
    {
      tool: "copy",
      args: { path: "task.txt", start: "OLD", target: "target.txt", targetStart: "DEST" },
      after: [4],
    },
  ],
  {
    modes: both,
    files: { ...textFile, "target.txt": "DEST\n" },
    expected: { "task.txt": "keep\nOLD\nadded\nlast\n", "target.txt": "DEST\nOLD\n" },
  },
);
add(
  "codemode-search-value-batch",
  ["compose.codemode-search-value-batch"],
  "In native Codemode, Search task.txt for beta and retain the returned value. Then in one script run the three independent edits concurrently with Promise.all, without any other tool between them: Insert added before alpha in task.txt; Replace beta by passing the first Search match value as path, with BETA; Delete gamma in task.txt by passing the literal string gamma as start. Keep omega. Reuse the native Search match value or its id without extracting textual SEARCH anchors. All three edits must belong to one committed editor batch.",
  [
    { tool: "search", args: { path: "task.txt", query: "beta" } },
    {
      tool: "insert",
      args: { path: "task.txt", anchor: "alpha", before: true },
      editorBatchSize: 3,
    },
    {
      tool: "replace",
      reuse: reuse(0),
      sameAssistantWith: 1,
      editorBatchSize: 3,
    },
    {
      tool: "delete",
      args: { path: "task.txt" },
      exactText: ["start"],
      sameAssistantWith: 2,
      editorBatchSize: 3,
    },
  ],
  {
    modes: ["codemode"],
    files: { "task.txt": "alpha\nbeta\ngamma\nomega\n" },
    expected: { "task.txt": "added\nalpha\nBETA\nomega\n" },
  },
);
add(
  "codemode-search-anchor-batch",
  ["compose.codemode-search-anchor-batch"],
  "In native Codemode, Search task.txt for regex:beta|gamma. The fixture retains that Search's unchanged readable output in .pi/issued-search.txt because script values expose RESULT ids, not SEARCH anchors. Use tools.read inside Codemode to Read .pi/issued-search.txt and extract the actual issued numbered SEARCH :line references for beta and gamma, ending in :line, not :match. Then in one script run these three independent edits concurrently with Promise.all, without Read/Search or another tool between them: Insert added before alpha in task.txt; Replace beta using its issued SEARCH reference as start, omitting path, with BETA; Delete gamma using its issued SEARCH reference as start, omitting path. Keep omega. Do not use RESULT ids or fabricate Search session ids. All three edits must belong to one committed editor batch.",
  [
    { tool: "search", args: { path: "task.txt", query: "regex:beta|gamma" } },
    { tool: "read", args: { path: ".pi/issued-search.txt" } },
    {
      tool: "insert",
      args: { path: "task.txt", anchor: "alpha", before: true },
      editorBatchSize: 3,
    },
    {
      tool: "replace",
      args: { path: undefined, start: /^SEARCH#[A-F0-9]+:1:line$/u },
      reuse: reuse(0, "start"),
      sameAssistantWith: 2,
      editorBatchSize: 3,
    },
    {
      tool: "delete",
      args: { path: undefined, start: /^SEARCH#[A-F0-9]+:2:line$/u },
      reuse: reuse(0, "start"),
      sameAssistantWith: 3,
      editorBatchSize: 3,
    },
  ],
  {
    modes: ["codemode"],
    setup: "native-search-batch",
    files: { "task.txt": "alpha\nbeta\ngamma\nomega\n" },
    expected: { "task.txt": "added\nalpha\nBETA\nomega\n" },
  },
);
add(
  // Fresh deferred-tool session; already-active guidance is covered by deterministic tests.
  "deferred-navigation-recovery",
  ["discovery.ast-search", "discovery.lsp-search", "discovery.diff", "discovery.undo"],
  'In direct mode, discover ast_search, lsp_search, diff and undo through tool_search before using them. In Codemode, call the session tools directly; discovery is optional. Use ast_search to find probe($ARG) in task.ts and lsp_search to find the symbol probe. Compare task.ts with itself using diff with the literal path strings before: "task.ts" and after: "task.ts"; in Codemode its value must be an empty string. Replace OLD with NEW in task.txt, then use undo with change: "last" to revert that edit. Read task.txt and report its restored marker. Preserve both files.',
  [
    {
      tool: "tool_search",
      discovers: ["ast_search", "lsp_search", "diff", "undo"],
    },
    { tool: "ast_search", args: { path: "task.ts", pattern: "probe($ARG)" }, contains: "probe(1)" },
    { tool: "lsp_search", args: { query: "probe" }, contains: "task.ts#probe" },
    { tool: "diff", args: { before: "task.ts", after: "task.ts" }, scriptResult: "" },
    { tool: "replace", args: { path: "task.txt", start: "OLD" } },
    { tool: "undo", args: { change: "last" }, after: [4] },
    { tool: "read", args: { path: "task.txt" }, contains: "OLD", after: [5] },
  ],
  {
    files: {
      ...textFile,
      "task.ts": "export function probe(value: number) { return value; }\nprobe(1);\n",
      "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
    },
    expected: {
      ...textFile,
      "task.ts": "export function probe(value: number) { return value; }\nprobe(1);\n",
      "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
    },
    answer: "OLD",
    prerequisite: "command -v typescript-language-server",
  },
);
add(
  "standalone-resource-host",
  ["standalone.discovery", "standalone.read-search-edit", "standalone.resource-bounds"],
  "Only standalone resource hosts are loaded; the full IDE is not enabled. In direct mode, discover the demo namespace through tool_search. In Codemode, call the demo tools directly; discovery is optional. Read the first line of memory://demo/note, Search that returned window for alpha, then Replace the returned search selection with changed. Preserve the second line omega. Attempt demo_read on local.txt, demo_read on memory://other/note and demo_copy from memory://demo/note to local.txt; all must fail without changing local.txt. Finally reread memory://demo/note. Use demo tools, not the sibling namespace or filesystem tools.",
  [
    {
      tool: "tool_search",
      discovers: ["demo_read", "demo_search", "demo_replace", "demo_copy"],
    },
    {
      tool: "demo_read",
      args: { path: "memory://demo/note", offset: 1, limit: 1 },
      contains: "alpha",
    },
    { tool: "demo_search", args: { query: "alpha" }, reuse: reuse(1), contains: "alpha" },
    { tool: "demo_replace", reuse: reuse(2) },
    { tool: "demo_read", args: { path: "local.txt" }, error: true },
    { tool: "demo_read", args: { path: "memory://other/note" }, error: true },
    { tool: "demo_copy", args: { path: "memory://demo/note", target: "local.txt" }, error: true },
    {
      tool: "demo_read",
      args: { path: "memory://demo/note" },
      contains: "changed\nomega",
      after: [3, 4, 5, 6],
    },
  ],
  {
    setup: "standalone-resource",
    files: {
      "resource.txt": "alpha\nomega\n",
      "other.txt": "sibling\n",
      "local.txt": "local sentinel\n",
    },
    expected: {
      "resource.txt": "changed\nomega\n",
      "other.txt": "sibling\n",
      "local.txt": "local sentinel\n",
    },
  },
);
add(
  "semantic-write-receipts",
  ["edit.semantic-write-receipt"],
  "Use Write once each, in this listed order, on fixture:semantic/applied, fixture:semantic/not-applied and fixture:semantic/unknown with content probe. These are synthetic resource actions, not files. Inspect each provider receipt: preserve the applied, not-applied or unknown effect and its attempted prefix. Never replay a refused or uncertain action. In Codemode a failed call resolves to null, so the remaining distinct actions still run. Report the lowercase word unknown for the uncertain action; do not call it a failed file save.",
  [
    {
      tool: "write",
      args: { path: "fixture:semantic/applied" },
      contains: "Semantic action applied",
      excludes: "Saved file.",
    },
    {
      tool: "write",
      args: { path: "fixture:semantic/not-applied" },
      error: true,
      contains: "Semantic action not-applied",
      excludes: "no file was written",
    },
    {
      tool: "write",
      args: { path: "fixture:semantic/unknown" },
      error: true,
      contains: "Semantic action unknown",
      excludes: "Write outcome unknown.",
    },
  ],
  {
    setup: "semantic-write",
    expected: {
      ...textFile,
      "attempts.jsonl":
        '{"effect":"applied","content":"probe"}\n{"effect":"not-applied","content":"probe"}\n{"effect":"unknown","content":"probe"}\n',
    },
    answer: "unknown",
  },
);
add(
  "semantic-script-receipts",
  ["compose.provider-structured-receipt"],
  'In native Codemode, call Insert once each on fixture:semantic-script/applied, fixture:semantic-script/not-applied and fixture:semantic-script/unknown with the argument text set to exactly "probe" (not "text probe"). These are synthetic actions, not files. Each call must resolve to an object receipt even when the action is refused or unknown. Pass each returned object unchanged to text(receipt), including its unpredictable nonce and attempted prefix. Do not parse the readable summary or invent a receipt. Never replay an action. Report the lowercase word unknown for the uncertain action.',
  ["applied", "not-applied", "unknown"].map((effect) => ({
    tool: "insert",
    args: { path: `fixture:semantic-script/${effect}` },
    error: effect !== "applied",
    contains: `Semantic action ${effect}`,
    parentStructuredValue: true,
    scriptResult: {
      kind: "fixture-action",
      ok: effect === "applied",
      effect,
      receipt: { attempted: 1, delivered: effect !== "not-applied" },
      nonce: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
    },
  })),
  {
    modes: ["codemode"],
    setup: "semantic-write",
    expected: {
      ...textFile,
      "attempts.jsonl":
        '{"effect":"applied","text":"probe"}\n{"effect":"not-applied","text":"probe"}\n{"effect":"unknown","text":"probe"}\n',
    },
    answer: "unknown",
  },
);
add(
  "ide-settings-catalog",
  ["read.ide-settings", "search.ide-settings"],
  "Read docs:ide-settings with limit 1000 to inspect the registered IDE settings. Find the registered ui.codemode preference. Search that exact ID in docs:ide-settings with caseSensitive true and limit 1000, then repeat the search in docs:all. Both searches must return locations under docs:ide-settings without editable Search references. Do not change configuration or fixture files.",
  [
    {
      tool: "read",
      args: { path: "docs:ide-settings", limit: 1000 },
      contains: "ui.codemode",
    },
    {
      tool: "search",
      args: {
        path: "docs:ide-settings",
        query: "ui.codemode",
        caseSensitive: true,
        limit: 1000,
      },
      contains: "docs:ide-settings:",
      excludes: "SEARCH#",
    },
    {
      tool: "search",
      args: {
        path: "docs:all",
        query: "ui.codemode",
        caseSensitive: true,
        limit: 1000,
      },
      contains: "docs:ide-settings:",
      excludes: "SEARCH#",
    },
  ],
  { expected: textFile },
);
add(
  "docs-search",
  ["search.docs-all", "search.docs-one", "search.docs-flags", "search.docs-readonly"],
  "Read docs:terminal. Search docs:terminal with query terminal, caseSensitive true, wholeWord true and limit 10. The result must contain guide-body locations under docs:terminal, not editable Search references. Then Search path docs:all with query regex:^# and limit 1000. Confirm it finds docs:terminal body headings rather than just the guide listing. Do not change files.",
  [
    { tool: "read", args: { path: "docs:terminal" } },
    {
      tool: "search",
      args: {
        path: "docs:terminal",
        query: "terminal",
        caseSensitive: true,
        wholeWord: true,
        limit: 10,
      },
      contains: "docs:terminal:",
      excludes: "SEARCH#",
    },
    {
      tool: "search",
      args: { path: "docs:all", query: "regex:^#", limit: 1000 },
      contains: "docs:terminal:",
      excludes: "RESULT#",
    },
  ],
  { expected: textFile },
);
add(
  "docs-search-status",
  ["search.docs-limit", "search.docs-empty", "search.docs-unknown", "search.docs-bare"],
  "Search all guide bodies with path docs:all, query regex:., and limit 1; the result must report incomplete coverage. Search docs:terminal with query regex:(?!) and confirm a successful empty result. Search path docs: with query regex:. and observe an error directing you to docs:all. Finally Search path docs:lpt-723-missing with query regex:. and observe an unknown-documentation-ID error, not a filesystem search or zero matches. In Codemode the failed call resolves to null. Do not change files.",
  [
    {
      tool: "search",
      args: { path: "docs:all", query: "regex:.", limit: 1 },
      contains: "incomplete",
    },
    {
      tool: "search",
      args: { path: "docs:terminal", query: "regex:(?!)" },
      contains: "No matches",
    },
    { tool: "search", args: { path: "docs:" }, error: true, contains: "Use docs:all" },
    {
      tool: "search",
      args: { path: "docs:lpt-723-missing" },
      error: true,
      contains: "Unknown documentation ID: lpt-723-missing",
    },
  ],
  { expected: textFile },
);
add(
  "ssh-guide",
  ["read.ssh-guide"],
  "The workspace has no configured SSH targets. Read docs:ssh through Read to learn how to configure a target. Do not open a connection or change any settings.",
  [{ tool: "read", args: { path: "docs:ssh" } }],
);
add(
  "delete-objects",
  ["edit.delete-directory", "edit.delete-symlink", "edit.delete-broken-symlink"],
  "Delete remove-tree recursively, then unlink link and broken-link using ordinary paths without text selectors. Leave sentinel.txt and tracked/data untouched.",
  [
    { tool: "delete", args: { path: "remove-tree" }, contains: "delete: applied" },
    { tool: "delete", args: { path: "link" }, contains: "delete: applied" },
    { tool: "delete", args: { path: "broken-link" }, contains: "delete: applied" },
  ],
  {
    files: deleteFixture,
    git: true,
    setup: "delete-objects",
    expected: {
      "remove-tree": null,
      "remove-tree/data": null,
      "remove-tree/link": null,
      "remove-tree/nested/data.bin": null,
      "remove-tree/broken": null,
      link: null,
      "broken-link": null,
    },
  },
);
add(
  "filesystem-yolo",
  ["edit.approval-yolo-delete", "edit.approval-yolo-move", "compose.yolo-protected-target"],
  "This fixture explicitly enables filesystem YOLO. Delete the tracked directory delete-tree and Move the tracked directory move-tree to moved-tree without a user UI. YOLO skips approval only: deleting .git/config must still be refused. Read moved-tree/data to confirm MOVE. In Codemode the protected-target refusal resolves to null and the read still runs.",
  [
    { tool: "delete", args: { path: "delete-tree" }, contains: "delete: applied" },
    { tool: "move", args: { path: "move-tree", target: "moved-tree" }, contains: "move: applied" },
    {
      tool: "delete",
      args: { path: ".git/config" },
      error: true,
      contains: "DELETE_PROTECTED_TARGET",
    },
    { tool: "read", args: { path: "moved-tree/data" }, contains: "MOVE" },
  ],
  {
    files: {
      "delete-tree/data": "DELETE\n",
      "move-tree/data": "MOVE\n",
      ".pi/pi-agent-ide/extensions.json": JSON.stringify({
        flags: { "pi-agent-ide-filesystem-yolo": true },
      }),
    },
    git: true,
    expected: {
      "delete-tree": null,
      "delete-tree/data": null,
      "move-tree": null,
      "move-tree/data": null,
      "moved-tree/data": "MOVE\n",
    },
  },
);
add(
  "delete-policy-gates",
  [
    "edit.delete-policy-refusal",
    "edit.delete-protected-path",
    "edit.delete-protected-root",
    "edit.approval-headless-delete",
    "compose.approval-refusal-read",
  ],
  "Use Delete on these exact paths, each as a whole object: the directory tracked itself (path tracked, not a file inside it), .git/config, the current directory (.), and filesystem root (/). All must be blocked in this non-interactive runtime. Deleting a directory with Git-tracked entries requires a host approval dialog; there is no user UI here, so it must fail closed rather than treating the prompt as permission. Then Read tracked/data and check its unchanged KEEP content. Keep all fixture bytes unchanged and report the refusal reasons. In Codemode each refusal resolves to null and the following calls still run.",
  [
    {
      tool: "delete",
      args: { path: "tracked" },
      error: true,
      contains: "DELETE_CONFIRMATION_REQUIRED",
    },
    {
      tool: "delete",
      args: { path: ".git/config" },
      error: true,
      contains: "DELETE_PROTECTED_TARGET",
    },
    { tool: "delete", args: { path: "." }, error: true, contains: "DELETE_PROTECTED_TARGET" },
    { tool: "delete", args: { path: "/" }, error: true, contains: "DELETE_PROTECTED_TARGET" },
    { tool: "read", args: { path: "tracked/data" }, contains: "KEEP" },
  ],
  { files: deleteFixture, git: true },
);
add(
  "directory-transfers",
  [
    "edit.copy-directory",
    "edit.move-directory",
    "edit.copy-symlink",
    "edit.move-symlink",
    "edit.copy-merge-directory",
    "edit.move-replace-directory",
    "compose.object-transfer-refusal",
  ],
  "Copy source-tree into merge-target, retaining copy-only and overwriting nested/data.bin. Move merge-target onto moved-target, removing move-only. Copy then move standalone link and broken-link to moved-link and moved-broken through temporary copied-link and copied-broken paths. Use ordinary paths with no text selectors. Preserve all link text without following targets. Read moved-target/nested/empty to check the empty directory exists. With direct calls, Search the unchanged first Copy result for BAD and observe that it has no reusable text selection. In Codemode that Copy resolves to null because it selects no text; skip that Search. Keep source-tree, link, broken-link, sentinel.txt, and tracked/data unchanged.",
  [
    {
      tool: "copy",
      args: { path: "source-tree", target: "merge-target" },
      contains: "copy: applied",
    },
    {
      tool: "move",
      args: { path: "merge-target", target: "moved-target" },
      contains: "move: applied",
    },
    { tool: "copy", args: { path: "link", target: "copied-link" }, contains: "copy: applied" },
    {
      tool: "move",
      args: { path: "copied-link", target: "moved-link" },
      contains: "move: applied",
    },
    {
      tool: "copy",
      args: { path: "broken-link", target: "copied-broken" },
      contains: "copy: applied",
    },
    {
      tool: "move",
      args: { path: "copied-broken", target: "moved-broken" },
      contains: "move: applied",
    },
    { tool: "read", args: { path: "moved-target/nested/empty" } },
    {
      tool: "search",
      reuse: reuse(0),
      error: true,
      contains: "no reusable text selection",
      // A Codemode script gets null for this Copy, so only a direct route can search its result.
      modes: ["direct"],
    },
  ],
  {
    files: deleteFixture,
    git: true,
    setup: "directory-transfers",
    expected: {
      "merge-target": null,
      "copied-link": null,
      "copied-broken": null,
      "merge-target/nested/data.bin": null,
      "merge-target/copy-only": null,
      "moved-target/move-only": null,
      "moved-target/nested/data.bin": "\0\n",
      "moved-target/copy-only": "KEEP\n",
      "moved-target/link": "symlink:/workspace/fixture/sentinel.txt",
      "moved-target/broken": "symlink:missing",
      "moved-link": "symlink:sentinel.txt",
      "moved-broken": "symlink:missing",
    },
  },
);
add(
  "directory-transfer-gates",
  [
    "edit.transfer-refusal",
    "edit.move-policy-refusal",
    "edit.approval-headless-move",
    "compose.approval-refusal-read",
  ],
  "Use Copy on source-tree to source-tree/new; it must refuse overlap. Use Copy from source-tree to link; it must refuse a symlink destination. Use Move on tracked to new-target; it must require a host approval dialog and fail closed in this non-interactive runtime. Use Move from source-tree to .git; it must refuse protected Git data. Then Read tracked/data in its own call to check unchanged KEEP content; new-target must not exist. Report the refusals and leave all fixture bytes unchanged. In Codemode each failure resolves to null and all checks still run.",
  [
    {
      tool: "copy",
      args: { path: "source-tree", target: "source-tree/new" },
      error: true,
      contains: "OVERLAPPING_PATHS",
    },
    {
      tool: "copy",
      args: { path: "source-tree", target: "link" },
      error: true,
      contains: "INVALID_FILE_TYPE",
    },
    {
      tool: "move",
      args: { path: "tracked", target: "new-target" },
      error: true,
      contains: "DELETE_CONFIRMATION_REQUIRED",
    },
    {
      tool: "move",
      args: { path: "source-tree", target: ".git" },
      error: true,
      contains: "DELETE_PROTECTED_TARGET",
    },
    { tool: "read", args: { path: "tracked/data" }, contains: "KEEP" },
  ],
  {
    files: deleteFixture,
    git: true,
    setup: "directory-transfers",
    expected: { "new-target": null },
  },
);
add(
  "parallel-directory-transfer-gates",
  ["compose.parallel-object-transfer-refusals"],
  (api) =>
    `${parallelCalls(api, 4)} Copy source-tree to source-tree/new (overlap refusal); Copy source-tree to link (symlink destination refusal); Move tracked to new-target (approval unavailable in this non-interactive runtime); Move source-tree to .git (protected Git data refusal). Do not submit these four calls sequentially or retry them. After all four refusals, Read tracked/data to check unchanged KEEP content. Leave every fixture byte unchanged; new-target and source-tree/new must not exist.`,
  [
    {
      tool: "copy",
      args: { path: "source-tree", target: "source-tree/new" },
      error: true,
      contains: "OVERLAPPING_PATHS",
    },
    {
      tool: "copy",
      args: { path: "source-tree", target: "link" },
      sameAssistantWith: 0,
      error: true,
      contains: "INVALID_FILE_TYPE",
    },
    {
      tool: "move",
      args: { path: "tracked", target: "new-target" },
      sameAssistantWith: 0,
      error: true,
      contains: "DELETE_CONFIRMATION_REQUIRED",
    },
    {
      tool: "move",
      args: { path: "source-tree", target: ".git" },
      sameAssistantWith: 0,
      error: true,
      contains: "DELETE_PROTECTED_TARGET",
    },
    { tool: "read", args: { path: "tracked/data" }, contains: "KEEP", after: [0, 1, 2, 3] },
  ],
  {
    modes: ["direct"],
    files: deleteFixture,
    git: true,
    setup: "directory-transfers",
    expected: { "new-target": null, "source-tree/new": null },
  },
);
add(
  "delete-temporary-defaults",
  ["edit.delete-temporary-defaults", "edit.delete-temporary-roots", "edit.delete-temporary-names"],
  "Delete nested/tmp/scratch, nested/.tmp/scratch, nested/temp/scratch, and nested/.temp/scratch through ordinary Delete paths. Then delete each named root itself: nested/tmp, nested/.tmp, nested/temp, and nested/.temp. This workspace has no Git; exact temporary path components need no approval. Leave sentinel.txt unchanged.",
  [
    ...["tmp", ".tmp", "temp", ".temp"].map((name) => ({
      tool: "delete",
      args: { path: `nested/${name}/scratch` },
      contains: "delete: applied",
    })),
    ...["tmp", ".tmp", "temp", ".temp"].map((name) => ({
      tool: "delete",
      args: { path: `nested/${name}` },
      contains: "delete: applied",
    })),
  ],
  {
    setup: "delete-temporary-no-git",
    files: {
      "sentinel.txt": "KEEP\n",
      ...Object.fromEntries(
        ["tmp", ".tmp", "temp", ".temp"].flatMap((name) => [
          [`nested/${name}/scratch/data`, "REMOVE\n"],
          [`nested/${name}/root-data`, "REMOVE\n"],
        ]),
      ),
    },
    expected: Object.fromEntries(
      ["tmp", ".tmp", "temp", ".temp"].flatMap((name) => [
        [`nested/${name}`, null],
        [`nested/${name}/scratch`, null],
        [`nested/${name}/scratch/data`, null],
        [`nested/${name}/root-data`, null],
      ]),
    ),
  },
);
add(
  "delete-temporary-config",
  ["edit.delete-temporary-config", "edit.move-temporary-config"],
  'Delete the directory custom itself (path custom). The project deletion setting replaces the default temporary roots with this custom directory. Then Delete nested/tmp, and Move nested/tmp with target: "moved": nested/tmp is no longer temporary, so both must require approval unavailable in this non-interactive runtime. Leave nested/tmp/data and sentinel.txt unchanged. In Codemode the expected refusals resolve to null.',
  [
    { tool: "delete", args: { path: "custom" }, contains: "delete: applied" },
    {
      tool: "delete",
      args: { path: "nested/tmp" },
      error: true,
      contains: "DELETE_CONFIRMATION_REQUIRED",
    },
    {
      tool: "move",
      args: { path: "nested/tmp", target: "moved" },
      error: true,
      contains: "DELETE_CONFIRMATION_REQUIRED",
    },
  ],
  {
    setup: "delete-temporary-no-git",
    files: {
      ".pi/pi-agent-ide/deletion.json": JSON.stringify({
        temporaryDirectories: { mode: "replace", paths: ["custom"] },
      }),
      "custom/data": "REMOVE\n",
      "nested/tmp/data": "KEEP\n",
      "sentinel.txt": "KEEP\n",
    },
    expected: { custom: null, "custom/data": null, moved: null },
  },
);
add(
  "move-temporary-directories",
  ["edit.move-temporary-defaults", "edit.copy-temporary-directory"],
  "Move nested/tmp over nested/temp, replacing its old contents without an approval dialog. Then Copy nested/temp into nested/.tmp, preserving the destination-only copy-only file. Use ordinary directory paths. This workspace has no Git; temporary roots and descendants are eligible. Leave sentinel.txt unchanged.",
  [
    {
      tool: "move",
      args: { path: "nested/tmp", target: "nested/temp" },
      contains: "move: applied",
    },
    {
      tool: "copy",
      args: { path: "nested/temp", target: "nested/.tmp" },
      contains: "copy: applied",
    },
  ],
  {
    setup: "delete-temporary-no-git",
    files: {
      "nested/tmp/data": "MOVE\n",
      "nested/temp/old": "REMOVE\n",
      "nested/.tmp/copy-only": "KEEP\n",
      "sentinel.txt": "KEEP\n",
    },
    expected: {
      "nested/tmp": null,
      "nested/tmp/data": null,
      "nested/temp/old": null,
      "nested/temp/data": "MOVE\n",
      "nested/.tmp/data": "MOVE\n",
    },
  },
);
function add(
  id: string,
  capabilities: string[],
  prompt: string | NonNullable<CapabilityCase["promptForApi"]>,
  steps: RouteStep[],
  extras: Partial<CapabilityCase> = {},
): void {
  cases.push({
    id,
    capabilities,
    prompt: typeof prompt === "function" ? prompt() : prompt,
    ...(typeof prompt === "function" && { promptForApi: prompt }),
    steps,
    modes: both,
    files: textFile,
    ...extras,
  });
}

add(
  "search-script-facts",
  [
    "search.script-facts",
    "compose.search-script-result",
    "ast.script-line-text",
    "codemode.failed-call-null",
    "codemode.failed-call-summary",
  ],
  "Use native Codemode to Search task.txt for regex:^ABSENT$ and confirm complete coverage with no matches. Replace that empty Search value with BAD; it must succeed without changes. ast_search scope.ts for probe($ARG) with limit 1, then Search that bounded result for regex:^ABSENT$. Confirm that the resulting empty Search is incomplete. Replace that incomplete value with BAD; the call must fail and resolve to null while the script continues. Also Replace in task.txt with the complete empty Search id as start and text BAD; this invalid endpoint must fail and resolve to null. Search task.txt for invalid regex:(, then for OLD with limit 1000. Check matches and complete instead of parsing display prose. Pass the final complete Search value unchanged to Replace with NEW, replacing all its matches and preserving keep/last. Report the facts and keep the failed calls visible in the summary without printing all matches.",
  [
    {
      tool: "search",
      args: { path: "task.txt", query: "regex:^ABSENT$" },
      scriptResult: { complete: true, matches: { length: 0 } },
    },
    { tool: "replace", reuse: reuse(0) },
    {
      tool: "ast_search",
      args: { path: "scope.ts", pattern: "probe($ARG)", limit: 1 },
      scriptResult: {
        complete: false,
        matches: { length: 1, 0: { text: "probe(first)", lineText: "probe(first);" } },
      },
    },
    {
      tool: "search",
      args: { query: "regex:^ABSENT$" },
      reuse: reuse(2),
      scriptResult: { complete: false, matches: { length: 0 } },
    },
    { tool: "replace", reuse: reuse(3), error: true },
    {
      tool: "replace",
      args: { path: "task.txt" },
      reuse: reuse(0, "start"),
      error: true,
    },
    {
      tool: "search",
      args: { path: "task.txt", query: "regex:(" },
      error: true,
    },
    {
      tool: "search",
      args: { path: "task.txt", query: "OLD", limit: 1000 },
      scriptResult: { complete: true, matches: { length: 2 } },
    },
    { tool: "replace", reuse: reuse(7) },
  ],
  {
    modes: ["codemode"],
    files: { "task.txt": "keep\nOLD\nOLD\nlast\n", "scope.ts": "probe(first);\nprobe(second);\n" },
    expected: {
      "task.txt": "keep\nNEW\nNEW\nlast\n",
      "scope.ts": "probe(first);\nprobe(second);\n",
    },
  },
);
add(
  "token-search-edit-guard",
  ["compose.token-search-edit-guard"],
  'Search split.txt for the unquoted query alpha beta. Attempt to Replace the whole broadened selection with BAD (in Codemode use the fallback object); it must fail without changing the file. In Codemode, the failed Replace resolves to null and the script can continue. Then search split.txt for the Boolean query alpha OR beta and replace only its first match with GREEN: pass that Search result as path ({id: its returned UUID} in direct calls, the returned value in Codemode) and its first :match reference as start (the first match value in Codemode). Omit end or repeat that same match. Finally search literal.txt for the quoted literal query "alpha beta" and replace that whole result with LITERAL. Preserve every other byte.',
  [
    { tool: "search", args: { path: "split.txt", query: /^alpha beta$/u } },
    {
      tool: "replace",
      reuse: reuse(0),
      error: true,
      contains: "alpha beta",
    },
    { tool: "search", args: { path: "split.txt", query: "alpha OR beta" } },
    {
      tool: "replace",
      reuse: reuse(2, ["path", "start"]),
    },
    { tool: "search", args: { path: "literal.txt", query: /^"alpha beta"$/u } },
    {
      tool: "replace",
      reuse: reuse(4, ["path", "start", "anchor"], "whole-result"),
    },
  ],
  {
    files: { "split.txt": "alpha\nbeta\n", "literal.txt": "alpha beta\n" },
    expected: { "split.txt": "GREEN\nbeta\n", "literal.txt": "LITERAL\n" },
  },
);
add(
  "search-script-fallback",
  ["search.script-fallback"],
  "Use Codemode to search split.txt for alpha beta. Check that the original matches list is empty and complete, and that the word fallback has two matches. Read the first fallback match by its id and report its text. Do not edit the file.",
  [
    {
      tool: "search",
      args: { path: "split.txt", query: "alpha beta" },
      scriptResult: {
        complete: true,
        matches: { length: 0 },
        fallback: { mode: "words", complete: true, matches: { length: 2 } },
      },
    },
    { tool: "read", args: { path: /^RESULT#[a-f\d-]{36}$/u }, reuse: reuse(0) },
  ],
  {
    modes: ["codemode"],
    files: { "split.txt": "alpha\nbeta\n" },
    expected: { "split.txt": "alpha\nbeta\n" },
    answer: "alpha",
  },
);
const rows = Array.from({ length: 150 }, (_, index) => `row ${String(index + 1)}`);
add(
  "search-script-match-ids",
  ["search.script-match-list", "compose.search-match-id"],
  "In one Codemode call, Search list.txt for regex:^row \\d+$. The value must list all 150 matches and be complete, with the last match on line 150. Replace only that last match with LAST by passing that match or its id as Replace's path, not the whole Search value, the file path or a line anchor. Report the number of matches in plain digits.",
  [
    {
      tool: "search",
      args: { path: "list.txt" },
      scriptResult: {
        complete: true,
        matches: {
          length: 150,
          149: { path: "list.txt", line: 150, text: "row 150", lineText: "row 150" },
        },
      },
    },
    { tool: "replace", args: { path: /^RESULT#[a-f\d-]{36}$/u }, reuse: reuse(0) },
  ],
  {
    modes: ["codemode"],
    files: { "list.txt": `${rows.join("\n")}\n` },
    expected: { "list.txt": `${[...rows.slice(0, -1), "LAST"].join("\n")}\n` },
    answer: "150",
  },
);

add(
  "binary-copy-move",
  ["edit.copy-binary", "edit.move-binary", "compose.binary-copy-refusal"],
  "Copy source.bin to copy.bin without decoding it. With direct calls, report the Copy receipt and Search the unchanged Copy result for BAD to observe that it has no text selection. In Codemode that Copy resolves to null because it selects no text; skip that Search. Move copy.bin over existing.bin. Keep source.bin unchanged and do not edit any other files.",
  [
    {
      tool: "copy",
      args: { path: "source.bin", target: "copy.bin" },
      contains: "No verified text selection",
    },
    {
      tool: "search",
      reuse: reuse(0),
      error: true,
      contains: "no reusable text selection",
      // A Codemode script gets null for this Copy, so only a direct route can search its result.
      modes: ["direct"],
    },
    { tool: "move", args: { path: "copy.bin", target: "existing.bin" } },
  ],
  {
    files: { "source.bin": "binary\u0000bytes\n", "existing.bin": "prior\u0000bytes\n" },
    expected: { "copy.bin": null, "existing.bin": "binary\u0000bytes\n" },
  },
);
add(
  "read-text",
  ["read.text", "read.directory", "read.raw", "read.paging"],
  'Use Read with path "." to list this directory. Read task.txt with offset 2 and limit 1. Read raw:task.txt with offset 0 and limit 4 to get its first four original bytes. Report the line-2 value.',
  [
    { tool: "read", args: { path: "." } },
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 }, contains: "OLD" },
    { tool: "read", args: { path: "raw:task.txt", offset: 0, limit: 4 }, contains: "keep" },
  ],
  { answer: "OLD" },
);

for (const mode of both)
  add(
    `read-error-${mode}`,
    mode === "codemode"
      ? [
          "read.failure",
          "read.provider-failure-ownership",
          "codemode.failed-call-null",
          "codemode.failed-call-summary",
          "codemode.provider-failure-context",
        ]
      : ["read.failure", "read.provider-failure-ownership"],
    "Read absent.txt once, then fixture:read-provider#metadata once, then read task.txt. The synthetic provider declares the fragmented resource unavailable; do not retry its bare source or interpret metadata as text. Keep existing files unchanged and report the first line of task.txt. In Codemode, run the three Reads in one script: a failed Read resolves to null, so check each value for null and continue with the independent task.txt read. Do not catch errors or parse readable error text; the Codemode result lists the failed Reads.",
    [
      {
        tool: "read",
        args: { path: "absent.txt" },
        error: true,
        contains: "absent.txt",
        ...(mode === "codemode" ? { parentContains: "- read absent.txt" } : {}),
      },
      {
        tool: "read",
        args: { path: "fixture:read-provider#metadata" },
        error: true,
        contains: "fixture:read-provider#metadata",
        ...(mode === "codemode"
          ? {
              parentContains: ["- read fixture:read-provider#metadata", "fixture-recovery-context"],
            }
          : {}),
      },
      { tool: "read", args: { path: "task.txt" }, contains: "keep" },
    ],
    {
      modes: [mode],
      setup: "semantic-write",
      expected: {
        ...textFile,
        "provider-reads.jsonl": '"fixture:read-provider#metadata"\n',
      },
      answer: "keep",
    },
  );
add(
  "read-jq",
  ["read.jq", "read.jq-paging"],
  "Use read with a jq view to select .status from config.json. Then read with jq:.status, .untouched, offset=2 and limit=1 to select the second transformed value. Report that number in plain digits. Do not edit anything.",
  [
    { tool: "read", args: { path: "config.json", views: ["jq:.status"] }, contains: "ready" },
    {
      tool: "read",
      args: { views: ["jq:.status, .untouched"], offset: 2, limit: 1 },
      // The first whole-file Read result names the same complete JSON source.
      reuse: { ...reuse(0), explicit: "config.json" },
      contains: "7",
    },
  ],
  {
    files: { "config.json": '{"status":"ready","untouched":7}\n' },
    expected: { "config.json": '{"status":"ready","untouched":7}\n' },
    answer: "7",
    prerequisite: "jq",
  },
);

add(
  "read-jq-bounded-input",
  ["read.jq-bounded-input"],
  "Read the first line of config.json. Pass that unchanged Read result or its UUID to Read with views jq:.status; the bounded-input query must be refused. Then query jq:.status using the explicit config.json path and report its value. Do not edit or widen the issued selection.",
  [
    {
      tool: "read",
      args: { path: "config.json", offset: 1, limit: 1 },
    },
    { tool: "read", args: { views: ["jq:.status"] }, reuse: reuse(0), error: true },
    { tool: "read", args: { path: "config.json", views: ["jq:.status"] }, contains: "ready" },
  ],
  {
    files: { "config.json": '{\n  "status": "ready"\n}\n' },
    expected: { "config.json": '{\n  "status": "ready"\n}\n' },
    answer: "ready",
    prerequisite: "jq",
  },
);
add(
  "read-search-replace",
  ["compose.read-search", "compose.search-replace", "compose.provider-reference-roundtrip"],
  "Read task.txt. Pass the unchanged Read result or its UUID into search for OLD, then pass the Search result into replace to change just OLD to NEW. Do not retype a file path for the dependent calls. In Codemode, when the runtime offers local MCP forwarding aliases for Search or Replace, use those aliases rather than their flat source names; still pass the actual returned references.",
  [
    { tool: "read", args: { path: "task.txt" } },
    { tool: "search", reuse: reuse(0) },
    { tool: "replace", reuse: reuse(1) },
  ],
  { expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

add(
  "rust-style-preservation",
  ["edit.rust-style-preservation"],
  'Use Replace with these exact inputs: {"path":"unformatted.rs","start":"value=1","text":"value=2"} and {"path":"formatted.rs","start":"let value = 1;","text":"let value=2;"}. The second replacement payload deliberately has no spaces around =. Submit that payload unchanged so the formatter exercises preservation of the existing formatted style and produces let value = 2;. Keep every other byte, including child.rs, unchanged.',
  [
    { tool: "replace", args: { path: "unformatted.rs", start: "value=1", text: "value=2" } },
    {
      tool: "replace",
      args: { path: "formatted.rs", start: "let value = 1;", text: "let value=2;" },
    },
  ],
  {
    files: {
      "Cargo.toml":
        '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "formatted.rs"\n',
      "Cargo.lock":
        '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 3\n\n[[package]]\nname = "fixture"\nversion = "0.1.0"\n',
      "unformatted.rs": 'fn main(){let value=1;println!("{}",value);}\n',
      "formatted.rs": "mod child;\n\nfn main() {\n    let value = 1;\n}\n",
      "child.rs": 'pub fn child(){println!("untouched");}\n',
    },
    expected: {
      "unformatted.rs": 'fn main(){let value=2;println!("{}",value);}\n',
      "formatted.rs": "mod child;\n\nfn main() {\n    let value = 2;\n}\n",
      "child.rs": 'pub fn child(){println!("untouched");}\n',
    },
    prerequisite: "command -v cargo && command -v rustfmt",
    postProcessing: true,
  },
);

add(
  "codemode-child-presentation",
  ["compose.codemode-child-result"],
  "In one native Codemode call, read task.txt and pass the unchanged Read result to text(). Keep the file unchanged. After the call, answer only CODEMODE-CHILD-MARKER. Do not use shell commands or substitute a standalone Read.",
  [
    {
      tool: "read",
      args: { path: "task.txt" },
      contains: "CODEMODE-CHILD-MARKER",
      parentContains: "CODEMODE-CHILD-MARKER",
    },
  ],
  {
    modes: ["codemode"],
    files: { "task.txt": "CODEMODE-CHILD-MARKER\n" },
    expected: { "task.txt": "CODEMODE-CHILD-MARKER\n" },
    answer: "CODEMODE-CHILD-MARKER",
  },
);
const streamedReplacement = Array.from(
  { length: 96 },
  (_, index) => `STREAM-PAYLOAD-${String(index + 1).padStart(4, "0")}`,
).join("\n");
add(
  "streamed-replace",
  ["edit.large-replace-payload"],
  `Use direct replace on task.txt with start OLD and text equal to this complete JSON string: ${JSON.stringify(streamedReplacement)}. Supply the literal text in the tool arguments, not a script, reference, abbreviation or repetition expression. Then read the first two lines of the saved file and report STREAM-PAYLOAD-0001. Keep the surrounding keep and last lines unchanged.`,
  [
    { tool: "replace", args: { path: "task.txt", start: "OLD", text: streamedReplacement } },
    {
      tool: "read",
      args: { path: "task.txt", offset: 1, limit: 2 },
      after: [0],
      contains: "STREAM-PAYLOAD-0001",
    },
  ],
  {
    modes: ["direct"],
    expected: { "task.txt": `keep\n${streamedReplacement}\nlast\n` },
    answer: "STREAM-PAYLOAD-0001",
  },
);

add(
  "issued-result-edit",
  [
    "edit.issued-result-streaming",
    "edit.result-anchor-combination",
    "compose.native-provider-auth",
  ],
  "Search task.txt for OLD. Replace the selected OLD with NEW by passing the unchanged Search result or its outer UUID as path, with text NEW and no start/end. Search the file again for NEW. Replace with that fresh Search result or UUID as path, start NEW, and text FINAL. This selector must resolve inside the issued selection, not treat its UUID as a filename. Read the current file and report FINAL. Keep every other byte unchanged.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    { tool: "replace", args: { start: undefined, end: undefined }, reuse: reuse(0) },
    { tool: "search", args: { path: "task.txt", query: "NEW" }, after: [1] },
    {
      tool: "replace",
      args: { start: "NEW" },
      reuse: reuse(2),
    },
    { tool: "read", args: { path: "task.txt" }, contains: "FINAL", after: [3] },
  ],
  { modes: ["direct"], expected: { "task.txt": "keep\nFINAL\nlast\n" }, answer: "FINAL" },
);

add(
  "read-scoped-boolean",
  ["compose.scoped-boolean"],
  'Read only line 2 of task.txt. Forward that result or its UUID to Search twice, using the exact queries `feature: "legacy​Checkout"` and `feature: AND outside`. Report both search results. Do not search the file path or change bytes.',
  [
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } },
    {
      tool: "search",
      args: { query: 'feature: "legacy​Checkout"' },
      reuse: reuse(0),
      contains: "1 match in 1 file",
    },
    {
      tool: "search",
      args: { query: "feature: AND outside" },
      reuse: reuse(0),
      contains: "No matches found",
    },
  ],
  {
    files: {
      "task.txt":
        'outside feature: "legacy​Checkout"\nfeature: "legacy​Checkout"\noutside feature: "legacy​Checkout"\n',
    },
  },
);
add(
  "search-issued-scope",
  ["compose.search-issued-scope", "compose.search-object-scope"],
  'Search task.txt for title. Pass the title Search\'s issued SEARCH :all:line selector as an object {"id":"SEARCH#…:all:line"} in Search path for legacyCheckout: there must be zero matches, because all feature lines are gaps. Use the same object form for the title Search\'s first :line when searching for first (one match), then the title Search\'s first :match for first (zero). Keep the bytes unchanged and use the exact issued selectors, not a file path or UUID.',
  [
    { tool: "search", args: { path: "task.txt", query: "title" } },
    {
      tool: "search",
      args: { path: { id: /^SEARCH#[A-F0-9]+:all:line$/ }, query: "legacyCheckout" },
      reuse: reuse(0),
      contains: "No matches found",
    },
    {
      tool: "search",
      args: { path: { id: /^SEARCH#[A-F0-9]+:1:line$/ }, query: "first" },
      reuse: reuse(0),
      contains: "1 match in 1 file",
    },
    {
      tool: "search",
      args: { path: { id: /^SEARCH#[A-F0-9]+:1:match$/ }, query: "first" },
      reuse: reuse(0),
      contains: "No matches found",
    },
  ],
  {
    // Numbered and :all selectors exist only in readable results; Codemode values carry ids.
    modes: ["direct"],
    files: {
      "task.txt":
        "title first\nfeature legacyCheckout\ntitle middle\nfeature legacyCheckout\ntitle final\n",
    },
  },
);
for (const operation of ["delete", "insert"] as const) {
  add(
    `search-line-batch-${operation}`,
    [
      `edit.search-line-batch-${operation}`,
      ...(operation === "insert" ? ["compose.batch-insert-search"] : []),
    ],
    (api) =>
      `Search task.txt for OLD. Use the three issued numbered SEARCH :line references as path for the three ${operation} calls. ${operation === "delete" ? "Remove only those selected lines and keep the file." : "Insert ADDED before each selected line."} ${parallelCalls(api, 3)} Do not use Codemode, sequential retries or rereads; keep all other bytes.${operation === "insert" ? " After the batch completes, Search each Insert result or UUID for ADDED (one match) and OLD OR keep (zero matches). Use the exact unquoted Boolean query OLD OR keep; do not quote it as one literal or translate it to regex. Keep those scopes separate." : ""}`,
    [
      { tool: "search", args: { path: "task.txt", query: "OLD" } },
      ...[1, 2, 3].map((index): RouteStep => ({
        tool: operation,
        args: {
          path: new RegExp(`^SEARCH#[A-F0-9]+:${index}:line$`, "u"),
          ...(operation === "insert" && { before: true }),
        },
        reuse: reuse(0),
        ...(index > 1 && { sameAssistantWith: 1 }),
      })),
      ...(operation === "insert"
        ? [1, 2, 3].flatMap((index): RouteStep[] => [
            {
              tool: "search",
              args: { query: "ADDED" },
              reuse: reuse(index),
              contains: "1 match in 1 file",
            },
            {
              tool: "search",
              args: { query: "OLD OR keep" },
              reuse: reuse(index),
              contains: "No matches found",
            },
          ])
        : []),
    ],
    {
      modes: ["direct"],
      files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\nOLD\n" },
      expected: {
        "task.txt":
          operation === "delete"
            ? "keep1\nkeep2\nkeep3\n"
            : "keep1\nADDED\nOLD\nkeep2\nADDED\nOLD\nkeep3\nADDED\nOLD\n",
      },
    },
  );
}
for (const operation of ["replace", "delete", "insert"] as const) {
  add(
    `selection-batch-${operation}`,
    [
      `edit.selection-batch-${operation}`,
      ...(operation === "replace" ? ["compose.batch-replace-search"] : []),
    ],
    (api) =>
      `Read complete lines 2, 4 and 6 of task.txt as three separate one-line windows (offset 2, 4 and 6 respectively, each with limit 1) before editing. Forward each corresponding Read result or UUID to its ${operation} call without another anchor. ${operation === "replace" ? "Replace each selected line with NEW followed by a newline." : operation === "delete" ? "Delete only these lines, keeping the file." : "Insert ADDED before each selected line."} ${parallelCalls(api, 3)} Do not use Codemode, sequential messages, rereads or retries. Keep every other byte.${operation === "replace" ? " After the batch completes, Search each Replace result or UUID for NEW (one match) and OLD OR keep (zero matches). Use the exact unquoted Boolean query OLD OR keep; do not quote it as one literal or translate it to regex. Keep those scopes separate." : ""}`,
    [
      ...[2, 4, 6].map((line): RouteStep => ({
        tool: "read",
        args: { path: "task.txt", offset: line, limit: 1 },
      })),
      ...[0, 1, 2].map((index): RouteStep => ({
        tool: operation,
        reuse: reuse(index),
        ...(index > 0 && { sameAssistantWith: 3 }),
        ...(operation === "insert" && { args: { before: true } }),
      })),
      ...(operation === "replace"
        ? [3, 4, 5].flatMap((index): RouteStep[] => [
            {
              tool: "search",
              args: { query: "NEW" },
              reuse: reuse(index),
              contains: "1 match in 1 file",
            },
            {
              tool: "search",
              args: { query: "OLD OR keep" },
              reuse: reuse(index),
              contains: "No matches found",
            },
          ])
        : []),
    ],
    {
      modes: ["direct"],
      files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\nOLD\n" },
      expected: {
        "task.txt":
          operation === "replace"
            ? "keep1\nNEW\nkeep2\nNEW\nkeep3\nNEW\n"
            : operation === "delete"
              ? "keep1\nkeep2\nkeep3\n"
              : "keep1\nADDED\nOLD\nkeep2\nADDED\nOLD\nkeep3\nADDED\nOLD\n",
      },
    },
  );
}
add(
  "insert-search-anchor-list",
  ["edit.insert-search-anchor-list"],
  "Search task.txt for OLD, then separately search task.txt for TAIL. Make ONE Insert call whose path is an array of two actual issued references: the first :line reference of the OLD search and the first :line reference of the TAIL search. Insert ADDED before each selected line (before: true). Do not retype the file path and do not retry. Keep every other byte.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    { tool: "search", args: { path: "task.txt", query: "TAIL" } },
    {
      tool: "insert",
      args: {
        path: [/^SEARCH#[A-F0-9]+:1:line$/u, /^SEARCH#[A-F0-9]+:1:line$/u],
        before: true,
      },
      reuse: [reuse(0), reuse(1)],
    },
  ],
  {
    // Line references exist only in readable results; a Codemode Search value has no line ids.
    modes: ["direct"],
    files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\nTAIL\n" },
    expected: { "task.txt": "keep1\nADDED\nOLD\nkeep2\nOLD\nkeep3\nADDED\nTAIL\n" },
  },
);
for (const operation of ["insert", "replace", "delete"] as const) {
  const selector = operation === "insert" ? "anchor" : "start";
  const lineReference = /^SEARCH#[A-F0-9]+:1:line$/u;
  add(
    `${operation}-list-selectors-refused`,
    [`edit.${operation}-list-selectors-refused`],
    `Search task.txt for OLD, then separately search task.txt for TAIL. Call ${operation} with path as an array of the first issued :line reference from each search, AND ${selector} as the first search's same :line reference.${operation === "delete" ? "" : " Use text NEW."}${operation === "insert" ? " Set before: true on this first call." : ""} This ambiguous combination must fail without changing either target. After that failure, retry once with the same path array but omit ${selector}; ${operation === "insert" ? "insert NEW before both selected lines with text NEW and before: true" : operation === "replace" ? "replace both selected lines with NEW" : "delete both selected lines, keeping the file"}. Do not retype the file path, reread or search again. Keep every other byte.`,
    [
      { tool: "search", args: { path: "task.txt", query: "OLD" } },
      { tool: "search", args: { path: "task.txt", query: "TAIL" } },
      {
        tool: operation,
        args: {
          path: [lineReference, lineReference],
          [selector]: lineReference,
        },
        error: true,
        reuse: [reuse(0), reuse(1), reuse(0, selector)],
      },
      {
        tool: operation,
        args: {
          path: [lineReference, lineReference],
          ...(operation === "insert" ? { before: true } : {}),
        },
        after: [2],
        reuse: [reuse(0), reuse(1)],
      },
    ],
    {
      // Readable Search line references are not part of the Codemode Search value.
      modes: ["direct"],
      files: { "task.txt": "keep1\nOLD\nkeep2\nTAIL\nkeep3\n" },
      expected: {
        "task.txt":
          operation === "insert"
            ? "keep1\nNEW\nOLD\nkeep2\nNEW\nTAIL\nkeep3\n"
            : operation === "replace"
              ? "keep1\nNEW\nkeep2\nNEW\nkeep3\n"
              : "keep1\nkeep2\nkeep3\n",
      },
    },
  );
}
add(
  "replace-search-anchor-list",
  ["edit.replace-search-anchor-list"],
  "Search task.txt for OLD, then separately search task.txt for TAIL. Make ONE Replace call whose path is an array of two actual issued references: the first match of the OLD search and the first match of the TAIL search (their :match references in direct calls, the matches themselves or their ids in Codemode). Replace both selected matches with NEW. Do not retype the file path, do not use start/end and do not retry. Keep every other byte.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    { tool: "search", args: { path: "task.txt", query: "TAIL" } },
    {
      tool: "replace",
      args: {
        path: [matchReference(1), matchReference(1)],
      },
      reuse: [reuse(0), reuse(1)],
    },
  ],
  {
    files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\nTAIL\n" },
    expected: { "task.txt": "keep1\nNEW\nkeep2\nOLD\nkeep3\nNEW\n" },
  },
);
add(
  "replace-already-done-anchor-list",
  ["edit.already-done-targets"],
  "Search task.txt for regex:OLD|NEW. Make ONE Replace call whose path is an array of all four actual matches of that search (their :match references in direct calls, the matches themselves or their ids in Codemode), replacing each with NEW. Two selected matches already contain NEW: the call must succeed, change the other two and name the targets that already had NEW. Do not retype the file path and do not retry. Keep every other byte.",
  [
    { tool: "search", args: { path: "task.txt", query: "regex:OLD|NEW" } },
    {
      tool: "replace",
      args: {
        path: [1, 2, 3, 4].map(matchReference),
      },
      reuse: [reuse(0), reuse(0), reuse(0), reuse(0)],
      contains: "Already had this text, left as is: 2 targets",
    },
  ],
  {
    files: { "task.txt": "keep1\nOLD\nNEW\nkeep2\nNEW\nOLD\n" },
    expected: { "task.txt": "keep1\nNEW\nNEW\nkeep2\nNEW\nNEW\n" },
  },
);
add(
  "replace-surviving-scoped-match",
  ["edit.surviving-scoped-match"],
  "Search task.txt for OLD once and retain the whole returned result. Replace its first match with ONE, passing that whole Search result as path ({id: its returned UUID} in direct calls, the returned value in Codemode) and its first match as start (the issued :match reference in direct calls, the first match value in Codemode). Omit end or repeat the same match. Then make one Replace call with path as an array of the first and second matches and text TWO; the stale first match must make it fail without writing. Finally replace only the second match with TWO, using the SAME WHOLE Search result as path and its second match as start. Do not pass the second match as path, retype the file path, search again or use other edits. Preserve every other byte.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    {
      tool: "replace",
      args: { start: matchReference(1), text: "ONE" },
      reuse: [reuse(0, "path", "whole-result"), reuse(0, "start")],
    },
    {
      tool: "replace",
      args: { path: [matchReference(1), matchReference(2)], text: "TWO" },
      error: true,
      after: [1],
      reuse: [reuse(0), reuse(0)],
    },
    {
      tool: "replace",
      args: { start: matchReference(2), text: "TWO" },
      after: [2],
      reuse: [reuse(0, "path", "whole-result"), reuse(0, "start")],
    },
  ],
  {
    files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\n" },
    expected: { "task.txt": "keep1\nONE\nkeep2\nTWO\nkeep3\n" },
  },
);
add(
  "replace-search-anchor-list-unusable",
  ["edit.search-anchor-list-unusable"],
  "Search task.txt for OLD. Replace its first match alone with ONE: use that Search result as path ({id: its returned UUID} in direct calls, the returned value in Codemode) and its first :match reference as start (the first match value in Codemode). Omit end or repeat that same match. Then make ONE Replace call whose path is an array of the first and the second match of that same search, replacing both with TWO. The first match was just changed, so the call must fail, name that reference and change nothing. Then call Replace once with only the second match and TWO. Do not search again and do not retype the file path. Keep every other byte.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    {
      tool: "replace",
      args: { path: matchReference(1) },
      reuse: reuse(0),
    },
    {
      tool: "replace",
      args: {
        path: [matchReference(1), matchReference(2)],
      },
      error: true,
      after: [1],
      reuse: [reuse(0), reuse(0)],
    },
    {
      tool: "replace",
      args: { path: matchReference(2) },
      after: [2],
      reuse: reuse(0),
    },
  ],
  {
    files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\n" },
    expected: { "task.txt": "keep1\nONE\nkeep2\nTWO\nkeep3\n" },
  },
);
for (const operation of ["delete", "insert"] as const) {
  add(
    `read-window-${operation}`,
    [`compose.read-window-${operation}`],
    `Read only the second line of task.txt (offset 2, limit 1). Forward that Read result or its UUID to ${operation}. Do not add a separate anchor or retype the file path. ${operation === "delete" ? "Remove only that line; keep the file." : 'Insert the literal text "BEFORE" as a new line before the selected line, with before: true; keep every original byte.'}`,
    [
      { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } },
      {
        tool: operation,
        ...(operation === "insert" && {
          args: { before: true },
        }),
        reuse: reuse(0),
      },
    ],
    {
      expected: {
        "task.txt": operation === "delete" ? "keep\nlast\n" : "keep\nBEFORE\nOLD\nlast\n",
      },
    },
  );
}
add(
  "grouped-replace-file-count",
  ["edit.grouped-file-count"],
  "In one native Codemode script, sequentially read lines 1, 2, then 3 of task.txt as one-line windows (offset equal to that line number, each with limit 1) and replace each issued Read result with NEW followed by a newline. Await each replacement before reading the next line so each gets a fresh snapshot. Inspect the final editor summary: it must report three replacements in one file, not three files.",
  [1, 2, 3].flatMap((line, index): RouteStep[] => [
    {
      tool: "read",
      args: { path: "task.txt", offset: line, limit: 1 },
      ...(index > 0 && { after: [index * 2 - 1] }),
    },
    {
      tool: "replace",
      reuse: reuse(index * 2),
      ...(line === 3 && { parentContains: "Applied 3 replacements in 1 file." }),
    },
  ]),
  {
    modes: ["codemode"],
    files: { "task.txt": "OLD\nOLD\nOLD\n" },
    expected: { "task.txt": "NEW\nNEW\nNEW\n" },
  },
);
const overviewFixtures = [
  { name: "lines", rows: 2100, padding: "  consume(value);" },
  { name: "bytes", rows: 1000, padding: `  consume("${"界".repeat(30)}");` },
].map(({ name, rows, padding }) => ({
  name,
  rows,
  files: {
    "large.ts": [
      'function outsideBefore() { return "NEEDLE"; }',
      "function checkout() {",
      ...Array<string>(100).fill(padding),
      '  consume("NEEDLE");',
      ...Array<string>(rows - 100).fill(padding),
      "}",
      'function outsideAfter() { return "NEEDLE"; }',
      "",
    ].join("\n"),
  },
}));
for (const { name, rows, files } of overviewFixtures) {
  add(
    `read-overview-search-${name}`,
    ["read.overview-source", "compose.overview-search", "compose.overview-window"],
    `Read all of large.ts so it returns a compact overview. Search for NEEDLE by passing that unchanged Read result or its UUID, not the file path. Then read large.ts with offset=2 and limit=${rows + 3}, and forward that new overview to Search for NEEDLE and outsideBefore. Report the source line of the body match and whether outsideBefore was found in the window. Do not edit anything.`,
    [
      { tool: "read", args: { path: "large.ts" }, contains: "Some source text is omitted." },
      {
        tool: "search",
        args: { query: "NEEDLE" },
        reuse: reuse(0),
        contains: "3 matches in 1 file",
      },
      {
        tool: "read",
        args: { path: "large.ts", offset: 2, limit: rows + 3 },
        contains: "outsideBefore",
      },
      {
        tool: "search",
        args: { query: "NEEDLE" },
        reuse: reuse(2),
        contains: "large.ts:103:12-18",
      },
      {
        tool: "search",
        args: { query: "outsideBefore" },
        reuse: reuse(2),
        contains: "No matches found",
      },
    ],
    // The overview is model-facing only: a Codemode script reads the exact text.
    { modes: ["direct"], files, expected: files },
  );
}
const storedOverview = overviewFixtures[0];
if (storedOverview === undefined) throw new Error("Missing overview fixture");
add(
  "read-large-store",
  ["compose.large-read-store-load"],
  "In one Codemode call, read large.ts with offset=2 and limit=2103, and store the unchanged Read result. In a second successful Codemode call, load that result and search it for NEEDLE, then pass the Search result to replace NEEDLE with FOUND. Do not reread the file or retype its path for the dependent calls. Finally load and search the original saved Read result for NEEDLE again and report whether the edited region still contains it.",
  [
    {
      tool: "read",
      args: { path: "large.ts", offset: 2, limit: 2103 },
      contains: 'consume("NEEDLE")',
    },
    {
      tool: "search",

      reuse: { ...reuse(0), newParent: true },
      contains: "large.ts:103:12-18",
    },
    { tool: "replace", reuse: reuse(1) },
    {
      tool: "search",

      reuse: reuse(0),
      contains: "No matches found",
      after: [2],
    },
  ],
  {
    modes: ["codemode"],
    files: storedOverview.files,
    expected: {
      "large.ts": storedOverview.files["large.ts"].replace('consume("NEEDLE")', 'consume("FOUND")'),
    },
  },
);

const largeJsonRows = Array.from({ length: 2500 }, (_, id) => ({
  id,
  name: `row ${id}`,
  status: "open",
}));
add(
  "read-large-json-script",
  ["codemode.read-exact-text"],
  "In one Codemode script, read data.json, a file larger than the model output limit, and parse its text with JSON.parse. Set status to done for the record with id 2499, then write the whole file back with JSON.stringify(rows, null, 2). Do not use Bash or the raw: prefix.",
  [
    { tool: "read", args: { path: "data.json" }, contains: '"name": "row 1250"' },
    { tool: "write", args: { path: "data.json" }, after: [0] },
  ],
  {
    modes: ["codemode"],
    files: { "data.json": JSON.stringify(largeJsonRows, null, 2) },
    expected: {
      "data.json": JSON.stringify(
        largeJsonRows.map((row) => (row.id === 2499 ? { ...row, status: "done" } : row)),
        null,
        2,
      ),
    },
  },
);

add(
  "read-script-values",
  ["codemode.read-bytes", "codemode.read-entries", "codemode.read-path-list"],
  'In one Codemode script, read raw:data.bin and take its base64 bytes, read the directory at path "folder" and take its entries sorted, and read a.txt, missing.txt and c.txt in one Read call with an array path; a path that fails becomes null. Write summary.txt with three lines and a final newline: the base64 bytes, the entries joined by commas, and the array items\' texts without their trailing newline joined by |, with missing for a null item. Do not use Bash.',
  [
    { tool: "read", args: { path: "raw:data.bin" } },
    { tool: "read", args: { path: "folder" } },
    { tool: "read", args: { path: ["a.txt", "missing.txt", "c.txt"] }, error: true },
    { tool: "write", args: { path: "summary.txt" }, after: [0, 1, 2] },
  ],
  {
    modes: ["codemode"],
    files: {
      "data.bin": "hi\n",
      "folder/b.txt": "beta\n",
      "folder/sub/x.txt": "x\n",
      "a.txt": "alpha\n",
      "c.txt": "gamma\n",
    },
    expected: { "summary.txt": "aGkK\nb.txt,sub/\nalpha|missing|gamma\n" },
  },
);

add(
  "search-anchor-insert",
  ["search.text", "compose.search-insert", "edit.insert"],
  "Search for OLD using task.txt as path. Insert NEW on the following line. In direct mode use the issued :line anchor as insert.path, or use task.txt as path plus that anchor, with text NEW. In Codemode pass the first Search match value unchanged, or its id, as insert.path; set text to a newline followed by NEW because the match selects OLD without its line break. Do not combine a result input with an anchor argument. Do not supply an extra blank line.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    {
      tool: "insert",
      modes: ["direct"],
      reuse: reuse(0, ["anchor", "path"], "anchor"),
    },
    { tool: "insert", modes: ["codemode"], reuse: reuse(0) },
  ],
  { expected: { "task.txt": "keep\nOLD\nNEW\nlast\n" } },
);

add(
  "search-multiline-between",
  ["search.multiline", "compose.search-multiline-replace", "compose.search-retained-result"],
  "Search task.txt with query regex:old one\\nold two\\n(?=END) and multiline true; pass backslash-n escapes in the regex. This selects both old lines and their following line breaks, not the marker lines. In Codemode confirm its only match has text old one followed by a newline, old two and a final newline. Retain this result, then Search task.txt with query keep. Replace the FIRST Search selection with text NEW followed by a newline, reusing its original reference or value, not the later Search. Keep the marker lines and all other bytes.",
  [
    {
      tool: "search",
      args: { path: "task.txt", query: /^regex:/, multiline: true },
      modes: ["direct"],
    },
    {
      tool: "search",
      args: { path: "task.txt", query: /^regex:/, multiline: true },
      modes: ["codemode"],
      scriptResult: {
        complete: true,
        matches: { length: 1, 0: { text: "old one\nold two\n" } },
      },
    },
    { tool: "search", args: { path: "task.txt", query: "keep" } },
    {
      tool: "replace",
      modes: ["direct"],
      reuse: reuse(0, ["path", "start"]),
    },
    {
      tool: "replace",
      modes: ["codemode"],
      reuse: reuse(1, ["path", "start"]),
    },
  ],
  {
    files: { "task.txt": "keep\nBEGIN\nold one\nold two\nEND\nkeep\n" },
    expected: { "task.txt": "keep\nBEGIN\nNEW\nEND\nkeep\n" },
  },
);

add(
  "search-query",
  ["search.text", "search.boolean", "search.regex", "file_search.glob", "search.flags"],
  "Use file_search with path . and pattern task*.txt. Search task.txt with the exact unquoted Boolean query alpha AND beta AND NOT skip. Search task.txt again with query regex:beta, wholeWord true, caseSensitive true and limit 1. Also Search task.txt for the plain text docs:debugger and then status:, passing each query unchanged. Report the Boolean matching line.",
  [
    { tool: "file_search", args: { pattern: /task\*?\.txt|task\*/ } },
    {
      tool: "search",
      args: {
        path: "task.txt",
        // Search reads a NOT factor anywhere in the conjunction alike.
        query:
          /^(?:(?:"alpha"|alpha) AND (?:"beta"|beta) (?:AND )?NOT (?:"skip"|skip)|NOT (?:"skip"|skip) AND (?:"alpha"|alpha) AND (?:"beta"|beta))$/,
      },
      contains: "PASS-MARKER",
    },
    {
      tool: "search",
      args: {
        path: "task.txt",
        query: /^regex:.*beta/,
        wholeWord: true,
        caseSensitive: true,
        limit: 1,
      },
      contains: "PASS-MARKER",
    },
    {
      tool: "search",
      args: { path: "task.txt", query: "docs:debugger" },
      contains: "DOCS-MARKER",
    },
    {
      tool: "search",
      args: { path: "task.txt", query: "status:" },
      contains: "STATUS-MARKER",
    },
  ],
  {
    files: {
      "task.txt":
        "alpha beta PASS-MARKER\nalpha beta skip\nAlpha BETAMAX\ndocs:debugger DOCS-MARKER\nstatus: STATUS-MARKER\n",
    },
    answer: "alpha beta PASS-MARKER",
  },
);

const listedDirectories = ["src/code-view", "src/api"];
const pathListFiles = {
  "src/code-view/format.ts":
    "export function formatSymbolSelector(name: string): string {\n  return name;\n}\n",
  "src/api/use.ts":
    'import { formatSymbolSelector } from "#format";\n\nexport const used = formatSymbolSelector("api"); // PASS-MARKER\n',
  "src/other/skip.ts":
    'import { formatSymbolSelector } from "#format";\n\nexport const skipped = formatSymbolSelector("other"); // OTHER-MARKER\n',
  "tsconfig.json":
    '{"compilerOptions":{"strict":true,"noEmit":true,"paths":{"#format":["./src/code-view/format.ts"]}},"include":["src"]}\n',
};
add(
  "search-path-list",
  ["search.path-list", "file_search.path-list", "ast_search.path-list"],
  "Look only in the directories src/code-view and src/api, never in src/other. Pass both directories together as one path list in each call: search for formatSymbolSelector, file_search for *.ts files, and ast_search for the calls formatSymbolSelector($$$ARGS). Report the file that calls formatSymbolSelector. Do not change files.",
  [
    {
      tool: "search",
      args: { path: listedDirectories },
      contains: "src/api/use.ts",
      excludes: "src/other",
    },
    {
      tool: "file_search",
      args: { path: listedDirectories },
      contains: "src/code-view/format.ts",
      excludes: "src/other",
    },
    {
      tool: "ast_search",
      args: { path: listedDirectories },
      contains: "PASS-MARKER",
      excludes: "OTHER-MARKER",
    },
  ],
  { files: pathListFiles, answer: "src/api/use.ts" },
);

add(
  "file-search-script-paths",
  ["file_search.script-paths", "file_search.script-limit", "compose.file-search-paths-read"],
  "Use native Codemode. The logs directory holds 150 .log files. Call file_search for *.log in logs without a limit and check that its value lists all 150 paths. Call it again with limit 2 and check that the value has two paths. Then read the path that ends with entry-137.log from the initial unlimited file_search result and report its content. Do not parse display text.",
  [
    {
      tool: "file_search",
      args: { pattern: /\*\.log|\.log/, path: "logs" },
      // A script's file_search has no default cap of 100 paths.
      scriptResult: { length: 150 },
    },
    {
      tool: "file_search",
      args: { pattern: /\*\.log|\.log/, path: "logs", limit: 2 },
      scriptResult: { length: 2 },
    },
    { tool: "read", args: { path: "logs/entry-137.log" }, contains: "PASS-137" },
  ],
  {
    modes: ["codemode"],
    files: Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [
        `logs/entry-${String(index)}.log`,
        `PASS-${String(index)}\n`,
      ]),
    ),
    answer: "PASS-137",
  },
);

add(
  "lsp-path-list",
  ["lsp_search.path-list"],
  "Use lsp_search with query formatSymbolSelector once, passing the directories src/code-view and src/api together as one path list. Never search src/other. Report the files in which it finds formatSymbolSelector. Do not change files.",
  [
    {
      tool: "lsp_search",
      args: { path: listedDirectories, query: "formatSymbolSelector" },
      contains: "src/api/use.ts",
      excludes: "src/other",
    },
  ],
  {
    files: pathListFiles,
    answer: "src/api/use.ts",
    prerequisite: "command -v typescript-language-server",
  },
);

add(
  "search-literal-operators",
  ["search.literal-operators", "search.script-line-text"],
  'Search task.txt with query equal to "flags | MASK", including the two double-quote characters around the phrase, so the vertical bar is literal. Report the full text of the only matching line. In Codemode use the returned match lineText, not text. Do not use Read or another tool to retrieve the line. Do not change files.',
  [
    {
      tool: "search",
      args: { path: "task.txt", query: /^"flags \| MASK"$/ },
      modes: ["direct"],
      contains: "PASS-MARKER",
      excludes: "flags only",
    },
    {
      tool: "search",
      args: { path: "task.txt", query: /^"flags \| MASK"$/ },
      modes: ["codemode"],
      scriptResult: {
        complete: true,
        matches: {
          length: 1,
          0: { text: "flags | MASK", lineText: "int x = flags | MASK; // PASS-MARKER" },
        },
      },
    },
  ],
  {
    files: {
      "task.txt":
        "int x = flags | MASK; // PASS-MARKER\nint y = flags; // flags only\nint z = MASK;\n",
    },
    answer: "int x = flags | MASK; // PASS-MARKER",
    forbiddenTools: ["read"],
  },
);

add(
  "read-anchor-replace",
  ["read.anchors", "edit.replace-range"],
  "Read task.txt with anchors. Using both returned line anchors as start and end, replace the inclusive first two lines with one line READY. Use the file path or omit path for this anchored edit, not a result scope. Keep last unchanged.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    {
      tool: "replace",
      args: {
        start: /^[0-9A-HJKMNP-TV-Z]{7}$/u,
        end: /^[0-9A-HJKMNP-TV-Z]{7}$/u,
      },
      reuse: [reuse(0, "start", "anchor"), reuse(0, "end", "anchor")],
    },
  ],
  { expected: { "task.txt": "READY\nlast\n" } },
);

add(
  "exact-range-replace",
  ["edit.replace-exact-range", "edit.leading-newline-range"],
  'Use Replace with paired literal endpoints and these exact inputs: {"path":"sentence.txt","start":"START","end":"END","text":"NEW"} and {"path":"credit.txt","start":"\\n\\nBased on","end":"(credit).","text":""}. The first call removes both endpoint fragments along with the text between them; its final line must be left NEW right, followed by the existing newline. In the second input, decode each \\n as one newline character. Remove only that suffix, retaining the entire preceding paragraph and its punctuation. Do not rewrite either whole file or use line anchors.',
  [
    {
      tool: "replace",
      args: { path: "sentence.txt" },
      exactText: ["start", "end"],
    },
    {
      tool: "replace",
      args: {
        path: "credit.txt",
        text: "",
      },
      exactText: ["start", "end"],
    },
  ],
  {
    files: {
      "sentence.txt": "left START old words END right\n",
      "credit.txt": "## Leave alone\n\nKEEP THIS PARAGRAPH.\n\nBased on [source](credit).",
    },
    expected: {
      "sentence.txt": "left NEW right\n",
      "credit.txt": "## Leave alone\n\nKEEP THIS PARAGRAPH.",
    },
  },
);

add(
  "exact-range-delete",
  ["edit.delete-exact-range", "compose.search-range-endpoints"],
  "Search sentence.txt separately for DELETE_BEGIN and DELETE_END. Use the exact :match reference from each Search (in Codemode, the id of its match) as Delete start and end, respectively. Delete the inclusive span between those endpoints, retaining left, right, both surrounding spaces and the line ending. Do not use :line references, a whole-file deletion, or one combined Search result as the source.",
  [
    { tool: "search", args: { path: "sentence.txt", query: "DELETE_BEGIN" } },
    { tool: "search", args: { path: "sentence.txt", query: "DELETE_END" } },
    {
      tool: "delete",
      args: {
        path: "sentence.txt",
        start: matchReference(1),
        end: matchReference(1),
      },
      reuse: [reuse(0, "start", "anchor"), reuse(1, "end", "anchor")],
    },
  ],
  {
    files: { "sentence.txt": "left DELETE_BEGIN old words DELETE_END right\n" },
    expected: { "sentence.txt": "left  right\n" },
  },
);

add(
  "exact-range-copy",
  [
    "edit.copy-exact-range",
    "edit.copy-exact-destination",
    "edit.copy-source-range",
    "compose.search-range-endpoints",
  ],
  "First Search target.txt separately for TARGET_BEGIN and TARGET_END. Use the two actual :match references as objects {id: reference} in Copy targetStart and targetEnd (in Codemode, pass the corresponding match values). Perform three transfers: (1) Copy the inline span in source.txt over that inclusive destination span in target.txt. Pass the literal strings COPY_BEGIN as start and COPY_END as end; do not use Search references or line anchors for these two source fields. (2) Copy the whole line 段🙂 from whole.txt with a single start and no end over the exact SLOT fragment in inline.txt, passing the literal string SLOT as both targetStart and targetEnd. Issue transfers (1) and (2) together, direct in the same assistant message or in Codemode with Promise.all. (3) Copy that same whole.txt line after the ANCHOR line in inserted.txt with targetStart ANCHOR and no targetEnd. Preserve the selected source line\u0027s CRLF in both destinations, even though their existing lines use LF. Leave both source files unchanged and preserve every byte outside the selected destination spans.",
  [
    { tool: "search", args: { path: "target.txt", query: "TARGET_BEGIN" } },
    { tool: "search", args: { path: "target.txt", query: "TARGET_END" } },
    {
      tool: "copy",
      args: {
        path: "source.txt",
        target: "target.txt",
        targetStart: { id: matchReference(1) },
        targetEnd: { id: matchReference(1) },
      },
      exactText: ["start", "end"],
      reuse: [reuse(0, "targetStart", "anchor"), reuse(1, "targetEnd", "anchor")],
    },
    {
      tool: "copy",
      sameAssistantWith: 2,
      args: {
        path: "whole.txt",
        end: undefined,
        target: "inline.txt",
      },
      exactText: ["targetStart", "targetEnd"],
    },
    {
      tool: "copy",
      args: {
        path: "whole.txt",
        end: undefined,
        target: "inserted.txt",
        targetEnd: undefined,
      },
    },
  ],
  {
    files: {
      "source.txt": "source prefix COPY_BEGIN body COPY_END source suffix\n",
      "target.txt": "target prefix TARGET_BEGIN old TARGET_END target suffix\n",
      "whole.txt": "before\r\n段🙂\r\nafter\r\n",
      "inline.txt": "left SLOT right\n",
      "inserted.txt": "ANCHOR\nAFTER\n",
    },
    expected: {
      "source.txt": "source prefix COPY_BEGIN body COPY_END source suffix\n",
      "target.txt": "target prefix COPY_BEGIN body COPY_END target suffix\n",
      "whole.txt": "before\r\n段🙂\r\nafter\r\n",
      "inline.txt": "left 段🙂\r\n right\n",
      "inserted.txt": "ANCHOR\n段🙂\r\nAFTER\n",
    },
  },
);

add(
  "exact-range-move",
  [
    "edit.move-exact-range",
    "edit.move-exact-destination",
    "edit.move-source-range",
    "compose.search-range-endpoints",
  ],
  "Search source.txt separately for MOVE_BEGIN and MOVE_END, then use their actual :match references (in Codemode, the ids of their matches) as Move start/end. Search target.txt separately for TARGET_BEGIN and TARGET_END. Prepare two independent Move calls. (1) Move the inline inclusive span from source.txt into target.txt using the destination :match references as objects {id: reference} in targetStart/targetEnd (in Codemode, pass the match values). (2) Move the final block 段🙂 followed by 尾界 from eof.txt over the exact SLOT fragment in inline.txt, passing the literal string 段🙂 followed by CRLF and 尾界 as start, no end, and the literal string SLOT as both targetStart and targetEnd. Issue both Move calls together, direct in the same assistant message or in Codemode with Promise.all. Preserve the sentence text, surrounding spaces and CRLF endings in source.txt and target.txt. Preserve the moved block\u0027s internal CRLF in the LF destination. Keep the preceding KEEP line and its CRLF in eof.txt; the unterminated block owns no preceding separator. Do not use a whole-file move.",
  [
    { tool: "search", args: { path: "source.txt", query: "MOVE_BEGIN" } },
    { tool: "search", args: { path: "source.txt", query: "MOVE_END" } },
    { tool: "search", args: { path: "target.txt", query: "TARGET_BEGIN" } },
    { tool: "search", args: { path: "target.txt", query: "TARGET_END" } },
    {
      tool: "move",
      args: {
        path: "source.txt",
        start: matchReference(1),
        end: matchReference(1),
        target: "target.txt",
        targetStart: { id: matchReference(1) },
        targetEnd: { id: matchReference(1) },
      },
      reuse: [
        reuse(0, "start", "anchor"),
        reuse(1, "end", "anchor"),
        reuse(2, "targetStart", "anchor"),
        reuse(3, "targetEnd", "anchor"),
      ],
    },
    {
      tool: "move",
      sameAssistantWith: 4,
      args: {
        path: "eof.txt",
        end: undefined,
        target: "inline.txt",
      },
    },
  ],
  {
    files: {
      "source.txt": "source prefix MOVE_BEGIN body MOVE_END source suffix\r\n",
      "target.txt": "target prefix TARGET_BEGIN old TARGET_END target suffix\r\n",
      "eof.txt": "KEEP\r\n段🙂\r\n尾界",
      "inline.txt": "left SLOT right\n",
    },
    expected: {
      "source.txt": "source prefix  source suffix\r\n",
      "target.txt": "target prefix MOVE_BEGIN body MOVE_END target suffix\r\n",
      "eof.txt": "KEEP\r\n",
      "inline.txt": "left 段🙂\r\n尾界 right\n",
    },
  },
);

add(
  "mixed-range-replace",
  ["edit.mixed-range-endpoints"],
  "Read line-start.txt with anchors; each line is shown after its 7-character anchor and a |. Replace from the anchor shown before line 1 through the exact END fragment on line 2 with NEW, preserving the suffix after END. Then Search line-end.txt for END. Replace from the exact START fragment on line 1 through that Search's :line reference with NEW followed by a newline. Preserve the prefix before START and the last line. Each endpoint keeps its own extent: do not widen an exact endpoint because the other endpoint selects a whole line.",
  [
    { tool: "read", args: { path: "line-start.txt", views: ["anchors"] } },
    {
      tool: "replace",
      args: { path: "line-start.txt", start: /^[0-9A-HJKMNP-TV-Z]{7}$/u, end: "END" },
      reuse: reuse(0, "start", "anchor"),
    },
    { tool: "search", args: { path: "line-end.txt", query: "END" } },
    {
      tool: "replace",
      args: {
        path: "line-end.txt",
        start: "START",
        end: /^SEARCH#[A-F0-9]+:1:line$/u,
      },
      reuse: reuse(2, "end", "anchor"),
    },
  ],
  {
    // Line references exist only in readable results; a Codemode Search value has no line ids.
    modes: ["direct"],
    files: {
      "line-start.txt": "KEEP prefix START selected\nEND suffix KEEP\nlast\n",
      "line-end.txt": "KEEP prefix START selected\nEND suffix KEEP\nlast\n",
    },
    expected: {
      "line-start.txt": "NEW suffix KEEP\nlast\n",
      "line-end.txt": "KEEP prefix NEW\nlast\n",
    },
  },
);

add(
  "write-read",
  ["edit.write", "edit.write-receipt", "compose.write-read"],
  "Use write to create answer.txt containing exactly ready plus a newline. Pass the returned whole-file result into read, and report the saved value.",
  [
    {
      tool: "write",
      args: { path: "answer.txt" },
      contains: "Read the file",
      excludes: "ready\n",
    },
    { tool: "read", reuse: reuse(0), contains: "ready" },
  ],
  { expected: { "answer.txt": "ready\n" }, answer: "ready" },
);

add(
  "write-hook-read",
  ["edit.write-hook-feedback", "compose.write-hook-read"],
  "Write review.txt containing exactly WRITE_HOOK_BODY review plus a newline. Report the saved-check hook's remark from the compact Write receipt, or in Codemode from the script's result, then pass that unchanged Write result into Read and report the saved value. Do not treat the remark as a failed or interrupted write.",
  [
    {
      tool: "write",
      args: { path: "review.txt" },
      contains: "Saved edit needs review",
      excludes: "WRITE_HOOK_BODY",
    },
    { tool: "read", reuse: reuse(0), contains: "WRITE_HOOK_BODY review" },
  ],
  {
    setup: "write-hook",
    expected: { "review.txt": "WRITE_HOOK_BODY review\n" },
    answer: "Saved edit needs review",
  },
);
add(
  "write-silent",
  ["codemode.silent-write"],
  "In one Codemode script, await write to create silent.txt containing exactly SILENT_WRITE_BODY plus a newline. Do not print, return, or log the Write result. Finish the script without output, then report completion.",
  [
    {
      tool: "write",
      args: { path: "silent.txt" },
      parentExcludes: "SILENT_WRITE_BODY",
    },
  ],
  { modes: ["codemode"], expected: { "silent.txt": "SILENT_WRITE_BODY\n" } },
);

add(
  "whole-file-script-receipts",
  ["codemode.whole-file-receipts"],
  "In one Codemode script, write saved.txt containing exactly RECEIPT_BODY plus a newline, copy copy-source.txt to copy-target.txt, then move move-source.txt to move-target.txt. Await each operation, and do not print, return, or log their values. Finish the script without output. Report completion from the script result.",
  [
    {
      tool: "write",
      args: { path: "saved.txt" },
      parentContains: "saved.txt",
      parentExcludes: "RECEIPT_BODY",
    },
    {
      tool: "copy",
      args: { path: "copy-source.txt", target: "copy-target.txt" },
      parentContains: "copy-target.txt",
      parentExcludes: "RECEIPT_BODY",
    },
    {
      tool: "move",
      args: { path: "move-source.txt", target: "move-target.txt" },
      parentContains: "move-target.txt",
      parentExcludes: "RECEIPT_BODY",
    },
  ],
  {
    modes: ["codemode"],
    files: { "copy-source.txt": "copy body\n", "move-source.txt": "move body\n" },
    expected: {
      "saved.txt": "RECEIPT_BODY\n",
      "copy-source.txt": "copy body\n",
      "copy-target.txt": "copy body\n",
      "move-source.txt": null,
      "move-target.txt": "move body\n",
    },
  },
);

add(
  "write-large-read",
  ["compose.write-large-read"],
  "Use one Codemode script to write large.txt with exactly 1024 copies of retained line followed by a newline (use repeat). Pass the returned Write result directly into Read with offset 1024 and limit 1. Print that Read result and report its last-line value. Do not shorten the saved content to match a display preview.",
  [
    { tool: "write", args: { path: "large.txt" } },
    { tool: "read", args: { offset: 1024, limit: 1 }, reuse: reuse(0), contains: "retained line" },
  ],
  {
    modes: ["codemode"],
    expected: { "large.txt": "retained line\n".repeat(1024) },
    answer: "retained line",
  },
);

add(
  "replace-read-search",
  ["edit.replace-exact", "compose.mutation-read", "compose.mutation-search"],
  "Use Replace, then use its result for Read and Search. Use replace on task.txt, passing the literal string OLD as start and NEW as text. Pass the mutation result to read (this read is required), then search within that same mutation result for NEW. Keep everything else.",
  [
    { tool: "replace", args: { path: "task.txt" }, exactText: ["start"] },
    { tool: "read", reuse: reuse(0), contains: "NEW" },
    { tool: "search", args: { query: "NEW" }, reuse: reuse(0), contains: "NEW" },
  ],
  { expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

add(
  "insert-before",
  ["edit.insert-before", "edit.insert-spacing", "edit.insert-exact-boundaries"],
  "Use Insert before the exact OLD line in task.txt to add a separate paragraph NOTE with blank-line separation. Then insert [ immediately before and ] immediately after the exact α🙂 fragment in literal.txt, passing the literal string α🙂 as anchor for both calls. Do the same around the multiline α followed by β fragment in block.txt, preserving its CRLF and the surrounding words. Pass the literal string α followed by CRLF followed by β as anchor for both calls, before true for [ and before false for ]. Pass actual newline characters in multiline anchors; do not paste printed line-anchor prefixes. Finally Search search.txt for MATCH and use its actual :match reference (in Codemode, the id of its match) as the Insert anchor to add [ immediately before that fragment. Search again after this change and use the fresh :match reference or match id to insert ] immediately after MATCH. Use ordinary line separation for the exact-fragment edits; add no new line breaks in those edits. Preserve all other bytes.",
  [
    {
      tool: "insert",
      args: {
        before: true,
        separation: "blank-line",
      },
    },
    {
      tool: "insert",
      args: { path: "literal.txt", before: true },
      exactText: ["anchor"],
    },
    {
      tool: "insert",
      args: { path: "literal.txt", before: false },
      exactText: ["anchor"],
    },
    {
      tool: "insert",
      args: { path: "block.txt", before: true },
      exactText: ["anchor"],
    },
    {
      tool: "insert",
      args: { path: "block.txt", before: false },
      exactText: ["anchor"],
    },
    { tool: "search", args: { path: "search.txt", query: "MATCH" } },
    {
      tool: "insert",
      args: {
        path: "search.txt",
        anchor: matchReference(1),
        before: true,
      },
      reuse: reuse(5, "anchor", "anchor"),
    },
    { tool: "search", args: { path: "search.txt", query: "MATCH" } },
    {
      tool: "insert",
      args: {
        path: "search.txt",
        anchor: matchReference(1),
        before: false,
      },
      reuse: reuse(7, "anchor", "anchor"),
    },
  ],
  {
    files: {
      ...textFile,
      "literal.txt": "left α🙂 right\n",
      "block.txt": "left α\r\nβ right\r\n",
      "search.txt": "left MATCH right\n",
    },
    expected: {
      "task.txt": "keep\n\nNOTE\n\nOLD\nlast\n",
      "literal.txt": "left [α🙂] right\n",
      "block.txt": "left [α\r\nβ] right\r\n",
      "search.txt": "left [MATCH] right\n",
    },
  },
);

add(
  "delete-selection",
  ["edit.delete-selection", "compose.search-delete"],
  "Search task.txt for the exact OLD fragment. Pass that Search result into delete, keeping the surrounding newline.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    { tool: "delete", reuse: reuse(0) },
  ],
  { expected: { "task.txt": "keep\n\nlast\n" } },
);

const declarationFiles = {
  "task.ts":
    'import { value } from "./helper";\nexport function doomed() { return value; }\nexport const label = "doomed";\n',
  "helper.ts": "export const value = 1;\n",
  "consumer.ts": 'import { doomed } from "./task";\nexport const result = doomed();\n',
  "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
};
const deletedDeclaration = {
  ...declarationFiles,
  "task.ts": 'import { value } from "./helper";\n\nexport const label = "doomed";\n',
};

add(
  "read-symbol-delete",
  ["edit.delete-declaration", "compose.symbol-read-delete"],
  "Use lsp_search with declaration task.ts#doomed, then pass its unchanged result or UUID (in Codemode, its value or its one match) to delete without start/end. Keep the source file, imports, the label string, and every reference unchanged. Do not reconstruct a path for Delete.",
  [
    { tool: "lsp_search", args: { declaration: "task.ts#doomed" }, contains: "function doomed" },
    { tool: "delete", args: { start: undefined, end: undefined }, reuse: reuse(0) },
  ],
  {
    files: declarationFiles,
    expected: {
      ...deletedDeclaration,
      "task.ts": 'import { value } from "./helper";\nexport const label = "doomed";\n',
    },
    prerequisite: "command -v typescript-language-server",
  },
);

const rejectionFiles = {
  "task.ts": "export class First { ping() {} }\nexport class Second { ping() {} }\n",
  "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
};
add(
  "reject-lsp-declaration",
  ["lsp.declaration-refusals"],
  "Ask lsp_search for declaration task.ts, task.ts#missing and task.ts#ping. Each must refuse its invalid, missing or ambiguous declaration selector. Do not edit or delete anything; keep all files unchanged.",
  ["task.ts", "task.ts#missing", "task.ts#ping"].map((declaration) => ({
    tool: "lsp_search",
    args: { declaration },
    error: true,
  })),
  {
    files: rejectionFiles,
    expected: rejectionFiles,
    prerequisite: "command -v typescript-language-server",
  },
);

add(
  "mixed-file-delete-text-edit",
  ["compose.file-delete-text-edit"],
  (api) =>
    `${parallelCalls(api, 4)} Include one Insert and three whole-file Deletes. Use Insert with path note.txt, anchor keep and text ${JSON.stringify("ADDED\n")} (no leading newline). Delete a.txt, b.txt and c.txt by ordinary paths without start/end. Keep note.txt and its other bytes; do not turn the file deletions into text selections.`,
  [
    { tool: "insert", args: { path: "note.txt", anchor: "keep" } },
    ...["a.txt", "b.txt", "c.txt"].map((source): RouteStep => ({
      tool: "delete",
      args: { path: source, start: undefined, end: undefined },
      sameAssistantWith: 0,
    })),
  ],
  {
    modes: ["direct"],
    files: {
      "note.txt": "keep\nnext\n",
      "a.txt": "remove\n",
      "b.txt": "remove\n",
      "c.txt": "remove\n",
    },
    expected: { "note.txt": "keep\nADDED\nnext\n", "a.txt": null, "b.txt": null, "c.txt": null },
  },
);

add(
  "file-copy-move-delete",
  ["edit.copy-file", "edit.move-file", "edit.delete-file", "edit.whole-file-omission"],
  "First use move with task.txt as both path and target; it must report not-applied. Then use copy to duplicate task.txt into copied.txt, move copied.txt to moved.txt, then delete moved.txt. Use ordinary file paths for these whole-file operations, without start/end or destination selection arguments. The original must stay unchanged.",
  [
    {
      tool: "move",
      args: {
        path: "task.txt",
        target: "task.txt",
        start: undefined,
        end: undefined,
        targetStart: undefined,
        targetEnd: undefined,
      },
      error: true,
      contains: "move: not-applied",
    },
    {
      tool: "copy",
      args: {
        path: "task.txt",
        target: "copied.txt",
        start: undefined,
        end: undefined,
        targetStart: undefined,
        targetEnd: undefined,
      },
    },
    {
      tool: "move",
      args: {
        path: "copied.txt",
        target: "moved.txt",
        start: undefined,
        end: undefined,
        targetStart: undefined,
        targetEnd: undefined,
      },
      contains: "move: applied",
    },
    { tool: "delete", args: { path: "moved.txt", start: undefined, end: undefined } },
  ],
  { expected: { "task.txt": textFile["task.txt"], "copied.txt": null, "moved.txt": null } },
);

add(
  "write-confirmed-readback",
  ["edit.write-canonicalized-snapshot", "compose.confirmed-write-readback"],
  "Write changed plus a newline once to fixture://saved-canonicalized/content. This provider stores uppercase text, so the successful result and a fresh Read must expose CHANGED rather than the submitted text. Then Write updated plus a newline once to fixture://saved-readback/content. This provider acknowledges persistence but cannot read the saved body on that resource instance. Preserve its applied effect, expect the post-write readback error (null in Codemode), and Read the explicit resource freshly to inspect updated. Never replay either write; report saved for the second one, not unknown delivery.",
  [
    {
      tool: "write",
      args: { path: "fixture://saved-canonicalized/content" },
      contains: "CHANGED",
    },
    {
      tool: "read",
      args: { path: "fixture://saved-canonicalized/content" },
      contains: "CHANGED",
      after: [0],
    },
    {
      tool: "write",
      args: { path: "fixture://saved-readback/content" },
      after: [1],
      error: true,
      contains: "READBACK",
      excludes: "Write outcome unknown.",
    },
    {
      tool: "read",
      args: { path: "fixture://saved-readback/content" },
      contains: "updated",
      after: [2],
    },
  ],
  {
    setup: "write-effects",
    files: { "saved.md": "before\n" },
    expected: {
      "saved.md": "updated\n",
      "attempts.jsonl": '{"content":"changed\\n"}\n{"content":"updated\\n"}\n',
    },
    answer: "saved",
  },
);
// Optional closed provider metadata does not change this effect/readback route.
// Write metadata projection is checked by deterministic resource-failure and structured-result tests.
add(
  "write-unknown-effects",
  ["edit.write-failure-recovery", "compose.uncertain-write-read"],
  "Write changed plus a newline to fixture://saved-mismatch/content. This isolated provider saves the bytes and then returns PROVIDER_SAVE_VERIFICATION_FAILED with unknown effects. Do not call this an unapplied write and do not replay it. Read the same explicit resource to inspect saved text, then report that the write effect is unknown. In Codemode, the failed Write resolves to null and the Read still runs. This headless case checks recovery, not the TUI failure panel.",
  [
    {
      tool: "write",
      args: { path: "fixture://saved-mismatch/content" },
      error: true,
      contains: "PROVIDER_SAVE_VERIFICATION_FAILED",
      excludes: "No file was changed.",
    },
    {
      tool: "read",
      args: { path: "fixture://saved-mismatch/content" },
      after: [0],
      contains: "changed",
    },
  ],
  {
    setup: "write-effects",
    files: { "saved.md": "before\n" },
    expected: { "saved.md": "changed\n", "attempts.jsonl": '{"content":"changed\\n"}\n' },
    answer: "unknown",
  },
);
add(
  "move-unknown-effects",
  ["edit.move-effects"],
  "Use whole-file move on .tmp/move-effects/unknown-after.txt to .tmp/move-effects/unknown-after-target.txt. This isolated fixture deliberately fails after execution starts. Preserve the unknown effect: do not call it not-applied and do not retry. Read the destination by its ordinary path to inspect the bytes and report that the Move effect is unknown. In Codemode, the failed call resolves to null and the inspection still runs.",
  [
    {
      tool: "move",
      args: {
        path: ".tmp/move-effects/unknown-after.txt",
        target: ".tmp/move-effects/unknown-after-target.txt",
      },
      error: true,
      contains: "move: unknown",
    },
    {
      tool: "read",
      args: { path: ".tmp/move-effects/unknown-after-target.txt" },
      after: [0],
      contains: "MOVED-BYTES",
    },
  ],
  {
    setup: "move-effects",
    files: {
      ".tmp/move-effects/owned.txt": "LPT-642 disposable fixtures\n",
      ".tmp/move-effects/unknown-after.txt": "MOVED-BYTES\n",
      ".tmp/move-effects/unknown-after-target.txt": "old target\n",
    },
    expected: {
      ".tmp/move-effects/unknown-after.txt": null,
      ".tmp/move-effects/unknown-after-target.txt": "MOVED-BYTES\n",
    },
    answer: "unknown",
  },
);

add(
  "copy-destination-recovery",
  ["edit.copy-destination-recovery"],
  "Exercise Copy destination recovery in task.txt. First Copy with path task.txt, start alpha, end beta and targetStart equal to the ambiguous text });, and observe its rejection. Then Read the current file with anchors and copy that same alpha-through-beta block after INSERT_HERE, using its issued destination anchor as targetStart. Keep the source selection unchanged. The rejected call must leave the file unchanged and the corrected call must copy the block exactly once.",
  [
    {
      tool: "copy",
      args: { path: "task.txt", targetStart: "});" },
      error: true,
      contains: "ambiguous",
    },
    { tool: "read", args: { path: "task.txt", views: ["anchors"] }, after: [0] },
    {
      tool: "copy",
      args: {
        path: "task.txt",
        targetStart: /^[0-9A-HJKMNP-TV-Z]{7}$/u,
      },
      reuse: reuse(1, "targetStart", "anchor"),
    },
  ],
  {
    files: { "task.txt": "alpha\nbeta\ngap\n});\nINSERT_HERE\n});\ntail\n" },
    expected: {
      "task.txt": "alpha\nbeta\ngap\n});\nINSERT_HERE\nalpha\nbeta\n});\ntail\n",
    },
  },
);
add(
  "selection-copy-move",
  [
    "edit.copy-selection",
    "edit.move-selection",
    "edit.copy-source-range",
    "edit.move-source-range",
    "compose.read-window-copy",
    "compose.read-window-move",
  ],
  "Read only the second line of task.txt (offset 2, limit 1). Copy that Read result to dest.txt with targetStart DEST and no targetEnd. Read the second line of task.txt again and Move that result to dest.txt with targetStart TAIL and no targetEnd. Then Read only the second line of copy-source.txt (offset 2, limit 1). Copy that returned window over only COPY_SLOT in copy-replaced.txt using paired targetStart/targetEnd, then copy the same window after the exact fragment COPY_POINT in copy-inserted.txt with targetStart and no targetEnd. Read two lines from move-replace-source.txt (offset 2, limit 2) and move that window over only MOVE_SLOT in move-replaced.txt using paired targetStart/targetEnd. Read two lines from move-insert-source.txt the same way and move that window after the exact fragment MOVE_POINT in move-inserted.txt with no targetEnd. Pass each returned Read result or its UUID unchanged as the source. Preserve the selected Unicode and CRLF bytes in these LF destinations, the surrounding destination text, and each Move source's preceding CRLF.",
  [
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } },
    { tool: "copy", args: { target: "dest.txt" }, reuse: reuse(0) },
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } },
    { tool: "move", args: { target: "dest.txt" }, reuse: reuse(2) },
    { tool: "read", args: { path: "copy-source.txt", offset: 2, limit: 1 } },
    {
      tool: "copy",
      args: {
        target: "copy-replaced.txt",
        targetStart: "COPY_SLOT",
        targetEnd: "COPY_SLOT",
      },
      reuse: reuse(4),
    },
    {
      tool: "copy",
      args: {
        target: "copy-inserted.txt",
        targetStart: "COPY_POINT",
        targetEnd: undefined,
      },
      reuse: reuse(4),
    },
    { tool: "read", args: { path: "move-replace-source.txt", offset: 2, limit: 2 } },
    {
      tool: "move",
      args: {
        target: "move-replaced.txt",
        targetStart: "MOVE_SLOT",
        targetEnd: "MOVE_SLOT",
      },
      reuse: reuse(7),
    },
    { tool: "read", args: { path: "move-insert-source.txt", offset: 2, limit: 2 } },
    {
      tool: "move",
      args: {
        target: "move-inserted.txt",
        targetStart: "MOVE_POINT",
        targetEnd: undefined,
      },
      reuse: reuse(9),
    },
  ],
  {
    files: {
      ...textFile,
      "dest.txt": "DEST\nTAIL\n",
      "copy-source.txt": "keep\r\n段🙂\r\nafter\r\n",
      "copy-replaced.txt": "left COPY_SLOT right\n",
      "copy-inserted.txt": "left COPY_POINT right\n",
      "move-replace-source.txt": "keep\r\n段🙂\r\n尾🙂",
      "move-replaced.txt": "left MOVE_SLOT right\n",
      "move-insert-source.txt": "keep\r\n段🙂\r\n尾🙂",
      "move-inserted.txt": "left MOVE_POINT right\n",
    },
    expected: {
      "task.txt": "keep\nlast\n",
      "dest.txt": "DEST\nOLD\nTAIL\nOLD\n",
      "copy-source.txt": "keep\r\n段🙂\r\nafter\r\n",
      "copy-replaced.txt": "left 段🙂\r\n right\n",
      "copy-inserted.txt": "left COPY_POINT段🙂\r\n right\n",
      "move-replace-source.txt": "keep\r\n",
      "move-replaced.txt": "left 段🙂\r\n尾🙂 right\n",
      "move-insert-source.txt": "keep\r\n",
      "move-inserted.txt": "left MOVE_POINT段🙂\r\n尾🙂 right\n",
    },
  },
);

for (const scenario of ["restored", "target-failed", "target-failed-after-restore"] as const) {
  const source = `.tmp/move-rollback/${scenario}-source.txt`;
  const target = `.tmp/move-rollback/${scenario}-target.txt`;
  const restored = scenario === "restored";
  add(
    `move-rollback-${scenario}`,
    ["edit.move-rollback"],
    `Move from path ${source} with start move-me and target ${target} with targetStart top and no targetEnd. The isolated fixture injects a write failure. Do not retry or repair the Move. Inspect its final failure result (including the final parent result on Codemode), then Read the source and the destination in two separate later calls. Report ${restored ? "restored" : "unknown"} for the destination's reported effect and explain why. A rejected rollback cannot prove final bytes, even if a later Read finds the original text.`,
    [
      {
        tool: "move",
        error: "direct",
        args: {
          path: source,
          target,
        },
      },
      { tool: "read", args: { path: source }, contains: "move-me", after: [0] },
      { tool: "read", args: { path: target }, contains: "bottom", after: [0] },
    ],
    {
      setup: "move-rollback",
      files: { [source]: "head\nmove-me\nend\n", [target]: "top\nbottom\n" },
      expected: {
        [target]: scenario === "target-failed" ? "top\nmove-me\nbottom\n" : "top\nbottom\n",
      },
      answer: restored ? "restored" : "unknown",
    },
  );
}

add(
  "paired-copy",
  ["compose.paired-sources-targets"],
  "Read a.txt and b.txt in separate calls. Also read dest-a.txt and dest-b.txt. Use copy with the a.txt and b.txt Read results as the path array and the dest-a.txt and dest-b.txt Read results as the target array, in those orders, replacing both whole destination files.",
  [
    { tool: "read", args: { path: "a.txt" } },
    { tool: "read", args: { path: "b.txt" } },
    { tool: "read", args: { path: "dest-a.txt" } },
    { tool: "read", args: { path: "dest-b.txt" } },
    {
      tool: "copy",
      reuse: [reuse(0, "path.0"), reuse(1, "path.1"), reuse(2, "target.0"), reuse(3, "target.1")],
    },
  ],
  {
    files: { "a.txt": "A\n", "b.txt": "B\n", "dest-a.txt": "old-a\n", "dest-b.txt": "old-b\n" },
    expected: { "dest-a.txt": "A\n", "dest-b.txt": "B\n" },
  },
);

add(
  "move-empty",
  ["edit.move-empty"],
  'Search task.txt and dest.txt separately with query "ABSENT" to get two empty results. Pass both unchanged results as Move\'s source and target. It must succeed without changes. Search the unchanged Move result with query "source"; it must find nothing. Do not edit any file.',
  [
    { tool: "search", args: { path: "task.txt", query: "ABSENT" } },
    { tool: "search", args: { path: "dest.txt", query: "ABSENT" } },
    { tool: "move", reuse: [reuse(0), reuse(1, "target")], contains: "no changes" },
    { tool: "search", args: { query: "source" }, reuse: reuse(2), contains: "No matches found" },
  ],
  {
    files: { "task.txt": "source\n", "dest.txt": "destination\n" },
    expected: { "task.txt": "source\n", "dest.txt": "destination\n" },
  },
);
add(
  "move-zero-width",
  ["edit.move-zero-width", "compose.move-point-replace", "compose.value-id-source"],
  'Search task.txt with query regex:^. Search dest.txt with query regex:(?<=^left ) for the point directly after "left " (character offset 5). Move the source point to the destination point using both unchanged Search results as path and target. In Codemode, pass the entire returned Search values unchanged, without extracting ids or matches. Move must succeed with no changes. Pass the unchanged Move result into replace with text NEW followed by one space. Only dest.txt should become left NEW right followed by its original newline.',
  [
    { tool: "search", args: { path: "task.txt", query: /^regex:/ } },
    { tool: "search", args: { path: "dest.txt", query: /^regex:/ } },
    {
      tool: "move",
      reuse: [reuse(0), reuse(1, "target")],
      contains: "No changes: zero-width selections.",
    },
    { tool: "replace", reuse: reuse(2) },
  ],
  {
    files: { "task.txt": "source\n", "dest.txt": "left right\n" },
    expected: { "task.txt": "source\n", "dest.txt": "left NEW right\n" },
  },
);

add(
  "read-diff",
  ["read.diff", "compose.read-diff"],
  "Read a.txt and b.txt separately. Pass their unchanged results or UUIDs as before and after to diff. Report the added line. Do not edit files.",
  [
    { tool: "read", args: { path: "a.txt" } },
    { tool: "read", args: { path: "b.txt" } },
    {
      tool: "diff",
      reuse: [reuse(0, "before"), reuse(1, "after")],
      contains: "NEW",
      scriptResult: /\n-OLD\n\+NEW$/u,
    },
  ],
  { files: { "a.txt": "OLD\n", "b.txt": "NEW\n" }, answer: "NEW" },
);

add(
  "diff-omission",
  ["read.diff-omission"],
  "Compare a.txt and b.txt with diff using before/after objects that contain only path. Omit offset and limit to compare the complete files and report the added line. Then diff the same files again with explicit limit 0 on both objects; that comparison must expose no file lines. Do not edit either file.",
  [
    {
      tool: "diff",
      args: {
        before: { path: "a.txt", offset: undefined, limit: undefined },
        after: { path: "b.txt", offset: undefined, limit: undefined },
      },
      contains: "NEW",
      scriptResult: /\n-OLD\n\+NEW$/u,
    },
    {
      tool: "diff",
      args: {
        before: { path: "a.txt", offset: undefined, limit: 0 },
        after: { path: "b.txt", offset: undefined, limit: 0 },
      },
      excludes: "NEW",
    },
  ],
  {
    files: { "a.txt": "OLD\n", "b.txt": "NEW\n" },
    expected: { "a.txt": "OLD\n", "b.txt": "NEW\n" },
    answer: "NEW",
  },
);

const addedRows = Array.from({ length: 2500 }, (_, index) => `row ${index}\n`).join("");
add(
  "diff-script-complete",
  ["codemode.diff-complete"],
  'In one Codemode script, diff before.txt against after.txt; after.txt has more lines than a tool result shows. Without printing the diff, count the lines of the returned string that start with "+" but not with "+++", and report that count in plain digits. Then diff before.txt against itself and check that the result is an empty string. Do not use Bash, the raw: prefix or temporary results, and do not edit files.',
  [
    {
      tool: "diff",
      scriptResult:
        /^--- \S*before\.txt\n\+\+\+ \S*after\.txt\n@@ -1,1 \+1,2501 @@\n head\n\+row 0\n[\s\S]*\n\+row 2499$/u,
    },
    { tool: "diff", scriptResult: "" },
  ],
  {
    modes: ["codemode"],
    files: { "before.txt": "head\n", "after.txt": `head\n${addedRows}` },
    expected: { "before.txt": "head\n", "after.txt": `head\n${addedRows}` },
    answer: "2500",
  },
);

for (const [name, eol] of [
  ["lf", "\n"],
  ["crlf", "\r\n"],
] as const) {
  add(
    `replace-line-boundary-${name}`,
    ["edit.replace-line-endings"],
    "Replace the exact heading ## OLD with ## NEW in heading.txt, without an end anchor or a newline in the replacement. Preserve the existing line endings and blank line before Body.",
    [{ tool: "replace", args: { path: "heading.txt", start: "## OLD", text: "## NEW" } }],
    {
      files: { "heading.txt": `## OLD${eol}${eol}Body${eol}` },
      expected: { "heading.txt": `## NEW${eol}${eol}Body${eol}` },
    },
  );
}
for (const [name, eol, ending] of [
  ["lf", "\n", "\n"],
  ["crlf", "\r\n", "\r\n"],
  ["unterminated", "\n", ""],
] as const) {
  add(
    `exact-eof-${name}`,
    ["edit.exact-eof", "edit.delete-empty-replace"],
    `Replace the exact final line Last with Final in last.txt. Delete the exact final block Last followed by Block in block.txt. Remove the identical final block in empty.txt using Replace with empty text. For both block edits, pass the literal string ${JSON.stringify(`Last${eol}Block`)} as start and omit the end parameter entirely. Decode the JSON escapes as actual line-separator characters; do not pass Search references or line anchors for these block edits. Read line.txt with anchors, then Delete only its final Last line using the actual returned line anchor. Preserve the preceding First line and its own separator in every deletion, including when the selected final line or block has no final newline. Keep unrelated bytes and each file's existing newline style.`,
    [
      { tool: "replace", args: { path: "last.txt", start: "Last" } },
      {
        tool: "delete",
        args: { path: "block.txt", end: undefined },
        exactText: ["start"],
      },
      {
        tool: "replace",
        args: { path: "empty.txt", text: "", end: undefined },
        exactText: ["start"],
      },
      { tool: "read", args: { path: "line.txt", views: ["anchors"] } },
      {
        tool: "delete",
        args: { path: "line.txt", start: "Last" },
        reuse: reuse(3, ["path", "start"], "anchor"),
      },
    ],
    {
      files: {
        "last.txt": `First${eol}Last${ending}`,
        "block.txt": `First${eol}Last${eol}Block${ending}`,
        "empty.txt": `First${eol}Last${eol}Block${ending}`,
        "line.txt": `First${eol}Last${ending}`,
      },
      expected: {
        "last.txt": `First${eol}Final${ending}`,
        "block.txt": `First${eol}`,
        "empty.txt": `First${eol}`,
        "line.txt": `First${eol}`,
      },
    },
  );
}
for (const method of ["all", "allSettled"] as const) {
  add(
    `parallel-edit-effects-${method}`,
    ["codemode.parallel-edit-effects", "compose.read-concurrent-edit-snapshot"],
    `In one native Codemode script, first Read insert.txt and delete.txt separately with the anchors view and retain both returned values. Then use one Promise.${method} to start six edits together, without awaiting an individual edit first. For the first two Inserts, pass the same unchanged insert Read value as path: insert FIRST plus a newline after first and MIDDLE plus a newline after middle. For the third Insert, pass "./insert.txt" as path and insert LAST plus a newline after last. For the first two Deletes, pass the same unchanged delete Read value as path: delete the unique whole lines first and middle. For the third Delete, pass "./delete.txt" as path and delete last. Use the corresponding line anchors from the Reads. Print every value: each Insert resolves to the id of its inserted text and each Delete to null; the script result lists any failed call. Preserve all other bytes, including the existing blank lines and EOF.`,
    [
      { tool: "read", args: { path: "insert.txt", views: ["anchors"] } },
      { tool: "read", args: { path: "delete.txt", views: ["anchors"] } },
      {
        tool: "insert",
        reuse: reuse(0),
      },
      {
        tool: "insert",
        reuse: reuse(0),
        parallelWith: 2,
      },
      {
        tool: "insert",
        args: { path: "./insert.txt" },
        parallelWith: 3,
      },
      { tool: "delete", reuse: reuse(1), parallelWith: 4 },
      { tool: "delete", reuse: reuse(1), parallelWith: 5 },
      { tool: "delete", args: { path: "./delete.txt" }, parallelWith: 6 },
    ],
    {
      modes: ["codemode"],
      files: {
        "insert.txt": "first\nmiddle\nlast\n",
        "delete.txt": "keep\nfirst\n\nmiddle\n\nlast\n",
      },
      expected: {
        "insert.txt": "first\nFIRST\nmiddle\nMIDDLE\nlast\nLAST\n",
        "delete.txt": "keep\n\n\n",
      },
    },
  );
}
add(
  "undo-last",
  ["edit.undo-last", "compose.mutation-undo"],
  'Change OLD to NEW in task.txt using replace, then undo the last editor transaction using undo with change equal to "last" (file is optional). Read the restored file and report its original marker.',
  [
    { tool: "replace", args: { path: "task.txt", start: "OLD" } },
    { tool: "undo", args: { change: "last" }, after: [0] },
    { tool: "read", args: { path: "task.txt" }, contains: "OLD", after: [1] },
  ],
  {
    files: { "task.txt": "keep\r\nOLD\r\n" },
    expected: { "task.txt": "keep\r\nOLD\r\n" },
    answer: "OLD",
  },
);

add(
  "git-stage-unstage-undo",
  ["git.changes", "git.stage", "git.stage-noop", "git.unstage", "git.undo-change", "discovery.git"],
  "Replace OLD with NEW in task.txt. Read its changes view, discover stage and unstage using native tool discovery, and stage the returned CHANGE anchor. Repeat stage with that anchor and confirm it succeeds as already staged. Read changes again and unstage its current CHANGE anchor. Read changes once more and undo that current change. Leave source and index at the original clean state.",
  [
    { tool: "replace" },
    { tool: "read", args: { path: "task.txt", views: ["changes"] }, after: [0] },
    {
      tool: "stage",
      args: { file: "task.txt" },
      reuse: reuse(1, "change", "change"),
      contains: "<system-result",
    },
    {
      tool: "stage",
      args: { file: "task.txt" },
      reuse: reuse(1, "change", "change"),
      contains: "already staged",
      after: [2],
    },
    { tool: "read", args: { path: "task.txt", views: ["changes"] }, after: [3] },
    { tool: "unstage", args: { file: "task.txt" }, reuse: reuse(4, "change", "change") },
    { tool: "read", args: { path: "task.txt", views: ["changes"] }, after: [5] },
    { tool: "undo", args: { file: "task.txt" }, reuse: reuse(6, "change", "change") },
  ],
  { git: true },
);

add(
  "read-search-narrow",
  ["compose.search-narrow-result"],
  "Read only line 1 of task.txt (offset 1, limit 1). Search inside that unchanged Read result with query regex:(?<=\\[)[^\\]]+(?=\\]), passing the regex backslashes unchanged. This selects only the text between the brackets. Replace that Search selection with NEW. Keep all other bytes, including the bracketed text on line 2.",
  [
    { tool: "read", args: { path: "task.txt", offset: 1, limit: 1 } },
    { tool: "search", args: { query: /^regex:/ }, reuse: reuse(0) },
    { tool: "replace", reuse: reuse(1) },
  ],
  {
    files: { "task.txt": "keep [OLD] keep\n[KEEP]\n" },
    expected: { "task.txt": "keep [NEW] keep\n[KEEP]\n" },
  },
);

add(
  // This route starts with one prepared index; live engine switching is verified separately.
  "semantic-code-search",
  ["search.semantic", "search.semantic-scope-filters", "compose.semantic-read"],
  "Use semantic_search with the exact query expire a user session in all three calls: first path ., then path src with spaces with include *.ts and exclude *.test.ts, then path src with spaces/session.ts. Read src with spaces/session.ts and report the function name. Do not change files.",
  [
    {
      tool: "semantic_search",
      args: { query: "expire a user session" },
      contains: "src with spaces/session.ts",
    },
    {
      tool: "semantic_search",
      args: {
        query: "expire a user session",
        path: "src with spaces",
        include: "*.ts",
        exclude: "*.test.ts",
      },
      contains: "src with spaces/session.ts",
      excludes: "src with spaces/noise.test.ts",
    },
    {
      tool: "semantic_search",
      args: { query: "expire a user session", path: "src with spaces/session.ts" },
      contains: "src with spaces/session.ts:1-1",
    },
    { tool: "read", args: { path: "src with spaces/session.ts" }, contains: "expireSession" },
  ],
  {
    // Serialize cold downloads and ONNX sessions, including searches after initialization.
    resource: "colgrep",
    prerequisite: "/bin/bash /source/benchmarks/tool-capabilities/prepare-colgrep.sh",
    files: {
      "src with spaces/session.ts":
        "export function expireSession(session: { expiresAt: number }) { return Date.now() >= session.expiresAt; }\n",
      "src with spaces/noise.test.ts":
        "export function testSession() { return 'session expiry'; }\n",
    },
    answer: "expireSession",
  },
);

add(
  "semantic-code-search-vera",
  ["search.semantic-vera", "search.semantic-vera-scope-filters", "compose.semantic-vera-read"],
  "Use semantic_search with the exact query expire a user session in all three calls: first path ., then path src with spaces with include *.ts and exclude *.test.ts, then path src with spaces/session.ts. Read src with spaces/session.ts and report the function name. Do not change files.",
  [
    {
      tool: "semantic_search",
      args: { query: "expire a user session" },
      contains: "src with spaces/session.ts",
    },
    {
      tool: "semantic_search",
      args: {
        query: "expire a user session",
        path: "src with spaces",
        include: "*.ts",
        exclude: "*.test.ts",
      },
      contains: "src with spaces/session.ts",
      excludes: "src with spaces/noise.test.ts",
    },
    {
      tool: "semantic_search",
      args: { query: "expire a user session", path: "src with spaces/session.ts" },
      contains: "src with spaces/session.ts:1-1",
    },
    { tool: "read", args: { path: "src with spaces/session.ts" }, contains: "expireSession" },
  ],
  {
    prerequisite:
      'command -v vera && export VERA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/pi-agent-ide/vera" VERA_NO_UPDATE_CHECK=1 && vera setup --potion-code --yes && vera index . --json',
    setup: "semantic-vera",
    files: {
      ".pi/pi-agent-ide/extensions.json": '{"preferences":{"search.semantic.engine":"vera"}}\n',
      "src with spaces/session.ts":
        "export function expireSession(session: { expiresAt: number }) { return Date.now() >= session.expiresAt; }\n",
      "src with spaces/noise.test.ts":
        "export function testSession() { return 'session expiry'; }\n",
    },
    answer: "expireSession",
  },
);
add(
  "semantic-vera-refresh",
  ["search.semantic-vera-refresh"],
  "Write fresh.ts with exactly `export function nebulaOtterRefreshSentinel() { return 73; }` followed by a newline. Then use semantic_search with path . and query nebulaOtterRefreshSentinel to find the newly written file, without running a separate index or update command. Report the returned path.",
  [
    {
      tool: "write",
      args: {
        path: "fresh.ts",
      },
    },
    {
      tool: "semantic_search",
      after: [0],
      args: { query: "nebulaOtterRefreshSentinel" },
      contains: "fresh.ts",
    },
  ],
  {
    prerequisite:
      'command -v vera && export VERA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/pi-agent-ide/vera" VERA_NO_UPDATE_CHECK=1 && vera setup --potion-code --yes && vera index . --json',
    setup: "semantic-vera",
    files: {
      ".pi/pi-agent-ide/extensions.json": '{"preferences":{"search.semantic.engine":"vera"}}\n',
      "initial.ts": "export function existing() { return 12; }\n",
    },
    expected: { "fresh.ts": "export function nebulaOtterRefreshSentinel() { return 73; }\n" },
    answer: "fresh.ts",
  },
);
add(
  "semantic-script-files",
  ["search.semantic-script-files"],
  "Use native Codemode. Call semantic_search with path . and query expire a user session, take the first file of its ranked value, read that file in the same script and report the function name. Do not parse display text.",
  [
    {
      tool: "semantic_search",
      args: { query: "expire a user session" },
      // The value lists ranked files; ranges stay in the readable text.
      scriptResult: { 0: "src with spaces/session.ts" },
    },
    { tool: "read", args: { path: "src with spaces/session.ts" }, contains: "expireSession" },
  ],
  {
    modes: ["codemode"],
    resource: "colgrep",
    prerequisite: "/bin/bash /source/benchmarks/tool-capabilities/prepare-colgrep.sh",
    files: {
      "src with spaces/session.ts":
        "export function expireSession(session: { expiresAt: number }) { return Date.now() >= session.expiresAt; }\n",
      "src with spaces/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
    },
    answer: "expireSession",
  },
);
const syntax = { "task.ts": "function first() { return 7; }\nfunction second() { return 9; }\n" };
add(
  "outline-search-edit",
  ["outline.file", "compose.outline-search-edit"],
  'Call outline for task.ts. Search its unchanged result for "first", passing the outline result itself (or its id) as path. Replace only the matched name with renamed, using the Search match or its displayed match reference. Do not read the whole file or replace a declaration.',
  [
    { tool: "outline", args: { path: "task.ts" }, contains: "first" },
    { tool: "search", reuse: reuse(0), contains: "first" },
    { tool: "replace", reuse: reuse(1) },
  ],
  {
    files: syntax,
    expected: { "task.ts": "function renamed() { return 7; }\nfunction second() { return 9; }\n" },
  },
);
add(
  "ast-capture-rename",
  ["outline.file", "search.ast", "compose.ast-capture-edit", "compose.capture-uuid-source"],
  'Call outline with path task.ts. Call ast_search with path task.ts, language typescript and pattern "function $NAME() { return 7; }". Replace the NAME capture with renamed, passing path as {id: "<bare UUID>"}. In direct calls, take the issued NAME capture RESULT# reference and remove the RESULT# prefix. In Codemode, bind the ast_search return value to result, take const captureId = result.matches[0].captures.NAME[0].id, then pass path: {id: captureId.replace(/^RESULT#/, "")}. The id field must contain only the capture UUID, with no RESULT# prefix. Do not use the whole result, a file path or an anchor.',
  [
    { tool: "outline", args: { path: "task.ts" }, contains: "first" },
    // A pattern or a rule with a pattern can both capture NAME.
    {
      tool: "ast_search",
      args: { path: "task.ts" },
      contains: "capture NAME",
    },
    {
      tool: "replace",
      args: {
        path: { id: /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u },
      },
      reuse: reuse(1, "path", "capture:NAME"),
    },
  ],
  {
    files: syntax,
    expected: { "task.ts": "function renamed() { return 7; }\nfunction second() { return 9; }\n" },
  },
);

add(
  "ast-search-enclosing",
  ["ast_search.rule", "compose.ast-search-enclosing"],
  'Search task.ts with query return 9. Then call ast_search with that unchanged Search result (the Search value in Codemode) as path, relation enclosing, language typescript and rule {kind: "function_declaration"}. Replace the returned whole function with text function second() { return 10; }. Keep the first function unchanged.',
  [
    { tool: "search", args: { path: "task.ts" }, contains: "return 9" },
    {
      tool: "ast_search",
      args: { relation: "enclosing", language: /^typescript$/i },
      reuse: reuse(0),
      contains: "function second",
    },
    { tool: "replace", reuse: reuse(1) },
  ],
  {
    files: syntax,
    expected: { "task.ts": "function first() { return 7; }\nfunction second() { return 10; }\n" },
  },
);

add(
  "read-ast-boundary",
  ["read.ast-view", "edit.scope-anchors"],
  "Read task.ts with the ast view. Use the returned begin/end scope anchors for the first function to replace that complete function with function renamed() { return 8; }. Keep the second function unchanged. Use ordinary file path plus scope anchors, not a result scope combined with start/end.",
  [
    { tool: "read", args: { path: "task.ts", views: ["ast"] }, contains: "scope-begin-" },
    {
      tool: "replace",
      args: {
        start: /scope-begin-/,
        end: /scope-end-/,
      },
      reuse: [reuse(0, "start", "anchor"), reuse(0, "end", "anchor")],
    },
  ],
  {
    files: {
      "task.ts":
        "function first() {\n  const value = 7;\n  return value;\n}\nfunction second() { return 9; }\n",
    },
    expected: { "task.ts": "function renamed() { return 8; }\nfunction second() { return 9; }\n" },
  },
);

add(
  "codemode-store",
  ["codemode.store-load", "compose.cross-call", "compose.provider-cross-call-reference"],
  "In one Codemode call, read task.txt and store the unchanged result. In a second Codemode call, load it and search within that result for OLD. Pass the resulting Search selection into replace to change OLD to NEW. Do not reread or retype the file path for the dependent operations.",
  [
    { tool: "read", args: { path: "task.txt" } },
    { tool: "search", reuse: { ...reuse(0), newParent: true } },
    { tool: "replace", reuse: reuse(1) },
  ],
  { modes: ["codemode"], expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

// Read and Search values carry their ids.
add(
  "value-id-source",
  ["compose.value-id-source"],
  "In one Codemode call, read task.txt and pass the Read value itself as Search's path to find OLD. Pass the returned Search value itself as Replace's path to change OLD to NEW. Do not pass result strings, the file path or a bare UUID to Search or Replace.",
  [
    { tool: "read", args: { path: "task.txt" } },
    { tool: "search", args: { path: { id: /^RESULT#/u } }, reuse: reuse(0) },
    { tool: "replace", args: { path: { id: /^RESULT#/u } }, reuse: reuse(1) },
  ],
  { modes: ["codemode"], expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

add(
  "stale-insert-recovery",
  ["edit.stale-insert-feedback", "edit.bounded-stale-feedback"],
  "Read task.txt with anchors. Replace OLD with NEW. Attempt Insert with the OLD Read's line-2 anchor and text BLOCKED; put path and anchor before text in its arguments. It must fail with stale-selector feedback, not a missing-payload mistake, and must not insert BLOCKED. Read the current file and insert RECOVERED plus a newline after its fresh line-2 anchor. Keep the other bytes.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    { tool: "replace", args: { path: "task.txt" }, after: [0] },
    {
      tool: "insert",
      args: { path: "task.txt", anchor: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: reuse(0, "anchor", "anchor"),
      error: true,
      after: [1],
      finalRefusal: { guardId: "stale-anchor", effect: "not-applied" },
      // Allow retention notices above the 50 KiB useful-text budget.
      finalMaxBytes: 64 * 1024,
    },
    { tool: "read", args: { path: "task.txt", views: ["anchors"] }, after: [2] },
    {
      tool: "insert",
      args: { path: "task.txt" },
      reuse: reuse(3, "anchor", "anchor"),
    },
  ],
  { modes: ["direct"], expected: { "task.txt": "keep\nNEW\nRECOVERED\nlast\n" } },
);

add(
  "repeated-line-anchor-after-shift",
  ["edit.repeated-line-anchor-shift"],
  "Read task.txt with anchors. Insert the line top before alpha, which shifts every line down. Wait for the Insert result before starting Delete. Then delete the final } line of the file using its anchor from the first Read, not a new Read and not exact text. Every other line must stay.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    {
      tool: "insert",
      args: { path: "task.txt", anchor: "alpha", before: true },
      after: [0],
    },
    {
      tool: "delete",
      args: { path: "task.txt", start: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: reuse(0, "start", "anchor"),
      after: [1],
    },
  ],
  {
    modes: ["direct"],
    files: { "task.txt": "alpha\nfn one() {\n  work();\n}\nfn two() {\n  more();\n}\n" },
    expected: { "task.txt": "top\nalpha\nfn one() {\n  work();\n}\nfn two() {\n  more();\n" },
  },
);

add(
  "repeated-line-anchor-after-block-delete",
  ["edit.repeated-line-anchor-block-recovery"],
  "Read task.txt with anchors. Delete the first definition, from its first template line through its first } line, using anchors from that Read. Attempt to delete the remaining template line using its anchor from the first Read; this stale anchor must be rejected. Then read task.txt with anchors again and delete the remaining template line using its fresh anchor. Do not use exact text. Preserve every other byte.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    {
      tool: "delete",
      args: {
        path: "task.txt",
        start: /^[0-9A-HJKMNP-TV-Z]{7}$/u,
        end: /^[0-9A-HJKMNP-TV-Z]{7}$/u,
      },
      reuse: reuse(0, ["start", "end"], "anchor"),
    },
    {
      tool: "delete",
      args: { path: "task.txt", start: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: reuse(0, "start", "anchor"),
      error: true,
      after: [1],
    },
    { tool: "read", args: { path: "task.txt", views: ["anchors"] }, after: [2] },
    {
      tool: "delete",
      args: { path: "task.txt", start: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: reuse(3, "start", "anchor"),
    },
  ],
  {
    modes: ["direct"],
    files: {
      "task.txt":
        "template <typename T>\nT one(T v) {\n  return v;\n}\ntemplate <typename T>\nT two(T v) {\n  return v;\n}\n",
    },
    expected: { "task.txt": "T two(T v) {\n  return v;\n}\n" },
  },
);

add(
  // Agent-facing scope refusals are unchanged; native anchor-rejection cards have scripted Pi coverage.
  "result-selector-scope",
  ["compose.result-selector-scope"],
  "Read task.txt with anchors; each line is shown after its 7-character anchor and a |. Then read only line 2 of task.txt. Pass that line-2 Read result unchanged as Replace's path together with the anchor the first Read shows before line 3 as start and text BAD: the anchor lies outside the result's selection, so the call must fail and name that selection. Then pass the same line-2 result as path with the anchor the first Read shows before line 2 as start and text NEW followed by a newline. Preserve all other bytes.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    // The window may also come from the first Read's result of the same file.
    { tool: "read", args: { offset: 2, limit: 1 } },
    {
      tool: "replace",
      args: { start: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: [reuse(1), reuse(0, "start", "anchor")],
      error: true,
      contains: "outside the result's selection: task.txt line 2",
      excludes: "ENOENT",
    },
    {
      tool: "replace",
      args: { start: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      after: [2],
      reuse: [reuse(1), reuse(0, "start", "anchor")],
    },
  ],
  { expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

add(
  "result-selector-exact-retry",
  ["compose.result-selector-scope"],
  "Read only line 2 of task.txt. Pass that Read result unchanged as Replace's path with start last and text BAD. The text exists outside the selection, so the call must fail without editing. Then pass the explicit task.txt path to Replace with start last and text fixed. This exact-text edit must succeed without an intervening anchor edit. Preserve all other bytes.",
  [
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } },
    {
      tool: "replace",
      args: { start: "last" },
      reuse: reuse(0),
      error: true,
    },
    { tool: "replace", args: { path: "task.txt", start: "last" } },
  ],
  { expected: { "task.txt": "keep\nOLD\nfixed\n" } },
);

add(
  "stale-recovery",
  ["compose.stale-recovery", "read.reference-recovery"],
  "Read task.txt with anchors. Change OLD to NEW using replace. Try to read the old Read result; it must be rejected as stale. Also read the current file after the replacement and report NEW; this is independent of the rejected old-result Read. Do not try to revive the old result.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    { tool: "replace", after: [0] },
    { tool: "read", error: true, reuse: reuse(0), after: [1] },
    { tool: "read", args: { path: "task.txt" }, contains: "NEW", after: [1] },
  ],
  { expected: { "task.txt": "keep\nNEW\nlast\n" }, answer: "NEW" },
);

add(
  // The first Bash call activates terminal guidance before shared-tool follow-up operations.
  // Schema publication and owner delivery are checked without inference in integration tests.
  "shell-roundtrip",
  [
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
  'Start Bash with command IFS= read -r line; printf \'%s\\n\' "$line" and background true; it waits for one input line, prints that line and exits. Wait for that first Bash result before choosing the shared-tool follow-up arguments from the available terminal guidance. Use its returned shell resource: write the text hello without Enter, insert the Enter key, then read the unchanged Write and Insert results to inspect that same shell. In Codemode, Write and Insert to a shell resolve to null because they select no text; skip those two Reads. Also read the completed shell using its original resource. The direct route may read all three sources together in one Read path array; preserve each actual result reference. Next attempt to replace hello with BAD through that terminal Read result and confirm the no-reusable-text-selection refusal: terminal output grants no file-edit authority. The streaming guard may refuse after path/start, before the text payload arrives; that early refusal is valid. After the refusal, search the shell\'s retained output with query "hello", then delete the shell session. Report the line printed by the shell. Do not edit files.',
  [
    { tool: "bash", args: { background: true } },
    { tool: "write", args: { content: "hello" }, reuse: reuse(0, "path", "shell") },
    { tool: "insert", args: { text: "Enter" }, reuse: reuse(0, "path", "shell"), after: [1] },
    // A Codemode script gets null for terminal input, so only a direct route can read its result.
    { tool: "read", reuse: reuse(1), contains: "hello", modes: ["direct"] },
    { tool: "read", reuse: reuse(2), contains: "hello", modes: ["direct"] },
    { tool: "read", reuse: reuse(0, "path", "shell"), contains: "hello", after: [2] },
    {
      tool: "replace",
      // Authority checks may refuse before either the selector or the payload arrives.
      reuse: reuse(5),
      error: true,
      contains: "no reusable text selection",
    },
    {
      tool: "search",
      args: { query: "hello" },
      after: [6],
      reuse: reuse(0, "path", "shell"),
      contains: "hello",
    },
    { tool: "delete", reuse: reuse(0, "path", "shell"), after: [7] },
  ],
  { expected: textFile, answer: "hello" },
);

add(
  "shell-screen",
  ["shell.image", "shell.sequence"],
  'Run Bash with command printf SCREEN-MARKER and background false. Read its returned shell resource with views ["image"], then with views ["sequence:duration=1,interval=0.25"]. The sequence must contain at least two frames. Report the printed marker. Do not edit files.',
  [
    { tool: "bash", args: { command: /SCREEN-MARKER/ } },
    {
      tool: "read",
      args: { views: ["image"] },
      reuse: reuse(0, "path", "shell"),
      image: true,
      scriptResult: { type: "image", mimeType: "image/png" },
    },
    {
      tool: "read",
      args: { views: [/^sequence(?::|$)/] },
      reuse: reuse(0, "path", "shell"),
      image: 2,
      scriptResult: { type: "images" },
    },
  ],
  { answer: "SCREEN-MARKER" },
);

add(
  "shell-catalog",
  ["shell.name", "shell.list", "shell.search-all", "shell.rename"],
  "Run Bash with command printf CATALOG-ONE; sleep 30, name catalog-worker and background true. Then run Bash with command printf CATALOG-TWO, background false and no name. Read the list of your terminal sessions, then search all of them at once for CATALOG. Rename catalog-worker to catalog-renamed, read the renamed session at its new address, and delete it. Report the marker the renamed session printed. Do not edit files.",
  [
    { tool: "bash", args: { name: "catalog-worker", background: true } },
    { tool: "bash", args: { command: /CATALOG-TWO/ } },
    { tool: "read", args: { path: "shell:" }, contains: "shell:catalog-worker" },
    { tool: "search", args: { path: "shell:", query: /CATALOG/ }, contains: "CATALOG-TWO" },
    { tool: "move", args: { path: "shell:catalog-worker", target: "shell:catalog-renamed" } },
    { tool: "read", args: { path: "shell:catalog-renamed" }, contains: "CATALOG-ONE" },
    { tool: "delete", args: { path: "shell:catalog-renamed" } },
  ],
  { expected: textFile, answer: "CATALOG-ONE" },
);

add(
  "shell-script-value",
  ["shell.script-value"],
  "Use native Codemode. Run the Bash command printf partial; exit 3 and take its exit code and output from the returned object, not from display text. A non-zero exit code is a value, not a failure; do not catch errors. Then run Bash with command printf READY; sleep 30 and background true, and delete its session using the session field of its returned object. Report the exit code and output of the first command. Do not edit files.",
  [
    {
      tool: "bash",
      args: { command: /exit 3/ },
      // A direct call still reports the non-zero exit as an error.
      error: true,
      scriptResult: { exit_code: 3, output: /partial/, truncated: false },
    },
    { tool: "bash", args: { background: true }, scriptResult: { session: /^shell:/ } },
    { tool: "delete", reuse: reuse(1, "path", "shell") },
  ],
  { modes: ["codemode"], expected: textFile, answer: "partial" },
);

add(
  "debug-roundtrip",
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
  "Discover debug and call it with adapter debugpy and program task.py. In Codemode, discovery alone does not activate shared-tool guidance; wait for the debug call to finish before choosing the follow-up arguments. First read the session using the returned debugger resource. Then use the available debugger guidance to read its source with anchors, place a breakpoint on the print line using insert breakpoint, and start the debugger. When stopped, evaluate value with insert evaluate value. Read the stopped session, report value in plain digits, then delete the debugger session. Source must stay unchanged.",
  [
    { tool: "debug", args: { adapter: "debugpy", program: "task.py" } },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    { tool: "read", args: { path: /debug:.*\/source/, views: ["anchors"] }, after: [0] },
    {
      tool: "insert",
      args: { path: /debug:.*\/source/, text: "breakpoint" },
      reuse: reuse(2, "anchor", "anchor"),
    },
    { tool: "insert", args: { text: "start" }, reuse: reuse(0, "path", "debug"), after: [3] },
    {
      tool: "insert",
      args: { text: "evaluate value" },
      after: [4],
      reuse: reuse(0, "path", "debug"),
      contains: "42",
    },
    { tool: "read", reuse: reuse(0, "path", "debug"), after: [5] },
    { tool: "delete", reuse: reuse(0, "path", "debug"), after: [6] },
  ],
  {
    files: { "task.py": "value = 42\nprint(value)\n" },
    answer: "42",
    prerequisite: "python3 -c 'import debugpy'",
  },
);

add(
  "debug-controls",
  [
    "debug.step-into",
    "debug.step-over",
    "debug.step-out",
    "debug.continue",
    "debug.delete-breakpoint",
    "compose.debug-breakpoint-delete-read-session",
    "read.breakpoints",
  ],
  "Discover debug and call it with adapter debugpy and program task.py. Wait for the debug result before choosing shared-tool arguments from the available debugger guidance. Read its source with anchors and place a breakpoint on the answer assignment. Read the source again with the breakpoints view. Start and read the stopped session. Step into the twice function and read the stopped session. Step over its first assignment and read the stopped session. Evaluate result while stopped, then step out and read the stopped session. Delete the returned breakpoint resource and read the session to confirm it is still stopped. Continue to completion, read the completed session, and delete the session. Report the evaluated result in plain digits. Do not change source files.",
  [
    { tool: "debug", args: { adapter: "debugpy", program: "task.py" } },
    { tool: "read", args: { path: /debug:.*\/source/, views: ["anchors"] } },
    {
      tool: "insert",
      args: { path: /debug:.*\/source/, text: "breakpoint" },
      reuse: reuse(1, "anchor", "anchor"),
    },
    { tool: "read", args: { path: /debug:.*\/source/, views: ["breakpoints"] }, contains: "twice" },
    { tool: "insert", args: { text: "start" }, reuse: reuse(0, "path", "debug") },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    { tool: "insert", args: { text: "step into" }, reuse: reuse(0, "path", "debug") },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    { tool: "insert", args: { text: "step over" }, reuse: reuse(0, "path", "debug") },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    {
      tool: "insert",
      args: { text: "evaluate result" },
      reuse: reuse(0, "path", "debug"),
      contains: "42",
    },
    { tool: "insert", args: { text: "step out" }, reuse: reuse(0, "path", "debug") },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    { tool: "delete", reuse: reuse(2, "path", "breakpoint") },
    { tool: "read", reuse: reuse(0, "path", "debug"), contains: "Status: stopped" },
    { tool: "insert", args: { text: "continue" }, reuse: reuse(0, "path", "debug") },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    { tool: "delete", reuse: reuse(0, "path", "debug") },
  ].map((step, index) => ({ ...step, ...(index > 0 && { after: [index - 1] }) })),
  {
    files: {
      "task.py":
        "def twice(value):\n    result = value * 2\n    return result\n\nvalue = 21\nanswer = twice(value)\nprint(answer)\n",
    },
    answer: "42",
    prerequisite: "python3 -c 'import debugpy'",
  },
);

add(
  "debug-backend-fallback",
  ["debug.backend-vscode-refusal", "debug.backend-native"],
  "Discover debug and call it with adapter debugpy, program task.py and backend vscode. When it reports that VS Code is unavailable, create a debugpy session with backend native instead. Wait for that debug result before choosing shared-tool arguments from the available debugger guidance. Read its source with anchors, place a breakpoint on the print line, start, evaluate value while stopped, and delete the session. Report value in plain digits. Do not change source files.",
  [
    {
      tool: "debug",
      args: { backend: "vscode", program: "task.py" },
      error: true,
      contains: "VS Code",
    },
    {
      tool: "debug",
      args: { backend: "native", adapter: "debugpy", program: "task.py" },
      after: [0],
    },
    { tool: "read", args: { path: /debug:.*\/source/, views: ["anchors"] }, after: [1] },
    {
      tool: "insert",
      args: { path: /debug:.*\/source/, text: "breakpoint" },
      reuse: reuse(2, "anchor", "anchor"),
    },
    { tool: "insert", args: { text: "start" }, reuse: reuse(1, "path", "debug"), after: [3] },
    {
      tool: "insert",
      args: { text: "evaluate value" },
      after: [4],
      reuse: reuse(1, "path", "debug"),
      contains: "42",
    },
    { tool: "delete", reuse: reuse(1, "path", "debug"), after: [5] },
  ],
  {
    files: { "task.py": "value = 42\nprint(value)\n" },
    answer: "42",
    prerequisite: "python3 -c 'import debugpy'",
  },
);

add(
  "diagnostics-report",
  ["diagnostics.file", "compose.diagnostics-read-search", "diagnostics.readonly-report"],
  "Call diagnostics for problem.ts. Reuse that exact report as path in Read, then reuse the original report as path in Search with query 2322. Attempt Replace with the original report as path, start broken and text changed; it must refuse, not edit the source. Report diagnostic code 2322 in plain digits. Do not change any files. In Codemode check the diagnostics value has text and id, and reuse that value unchanged.",
  [
    {
      tool: "diagnostics",
      args: { path: "problem.ts" },
      contains: "typescript-language-server:2322",
    },
    { tool: "read", reuse: reuse(0), contains: "typescript-language-server:2322" },
    { tool: "search", args: { query: "2322" }, reuse: reuse(0), contains: "2322" },
    { tool: "replace", reuse: reuse(0), error: true },
  ],
  {
    files: {
      "problem.ts": 'export function broken(): number {\n  return "diagnostic";\n}\n',
      "tsconfig.json": '{"compilerOptions":{"strict":true,"noEmit":true},"include":["*.ts"]}\n',
      ".pi/pi-agent-ide/extensions.json": '{"flags":{"pi-agent-ide-no-diagnostic-buffer":true}}\n',
    },
    expected: { "problem.ts": 'export function broken(): number {\n  return "diagnostic";\n}\n' },
    answer: "2322",
    prerequisite: "command -v typescript-language-server",
  },
);
add(
  "rust-diagnostics-no-build",
  ["read.rust-diagnostics-no-build"],
  "Read src/main.rs with the diagnostics view, then use lsp_search with declaration src/main.rs#main to confirm the Rust server is running. Call diagnostics with path src/main.rs. Keep the source and tool configuration unchanged. Do not run Cargo or enable build-backed diagnostics. Report the main function name; an incomplete native diagnostic snapshot is acceptable.",
  [
    { tool: "read", args: { path: "src/main.rs", views: ["diagnostics"] } },
    { tool: "lsp_search", args: { declaration: "src/main.rs#main" }, contains: "main" },
    { tool: "diagnostics", args: { path: "src/main.rs" } },
  ],
  {
    files: {
      "Cargo.toml":
        '[package]\nname = "rust-diagnostic-capability"\nversion = "0.1.0"\nedition = "2021"\n',
      // Cargo metadata creates this during server startup even when compilation is disabled.
      "Cargo.lock":
        '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 3\n\n[[package]]\nname = "rust-diagnostic-capability"\nversion = "0.1.0"\n',
      "src/main.rs": "fn main() {}\n",
      // No dependencies: an accidental build stays small and records its side effect.
      "build.rs":
        'fn main() { std::fs::write("build-attempted", "unexpected").unwrap(); panic!("unexpected diagnostic build"); }\n',
    },
    expected: { "src/main.rs": "fn main() {}\n", "build-attempted": null },
    forbiddenTools: ["bash", "write", "replace", "insert", "delete"],
    prerequisite: "rust-analyzer --version && cargo clippy --version",
  },
);

add(
  "lsp-read",
  ["lsp.symbols", "lsp.references", "lsp.graph", "lsp.diagnostics", "read.diagnostics-view"],
  "Use lsp_search with query count on task.ts, then lsp_search again with that returned result as path and references true to find its usage. Use lsp_search with declaration task.ts#count, then with calls task.ts#count. Call diagnostics with path problem.ts and also read problem.ts with the diagnostics view; wait for the actual TypeScript error report, not a pending/unavailable status. Report the declared count value and diagnostic code in plain digits. Do not change files.",
  [
    {
      tool: "lsp_search",
      args: { path: "task.ts", query: "count" },
      contains: "count",
    },
    {
      tool: "lsp_search",
      args: { query: "count", references: true },
      reuse: reuse(0),
      contains: "count",
    },
    { tool: "lsp_search", args: { declaration: /^task.ts#.*count$/ }, contains: "3" },
    { tool: "lsp_search", args: { calls: /^task.ts(?:#.*)?$/ }, contains: "References" },
    {
      tool: "diagnostics",
      args: { path: "problem.ts" },
      contains: "typescript-language-server:2322",
    },
    {
      tool: "read",
      args: { path: "problem.ts", views: ["diagnostics"] },
      contains: "typescript-language-server:2322",
    },
  ],
  {
    files: {
      "task.ts": "export const count = 3;\nexport const doubled = count * 2;\n",
      "tsconfig.json": '{"compilerOptions":{"strict":true,"noEmit":true},"include":["*.ts"]}\n',
      "problem.ts": 'export function broken(): number {\n  return "diagnostic";\n}\n',
      ".pi/pi-agent-ide/extensions.json": '{"flags":{"pi-agent-ide-no-diagnostic-buffer":true}}\n',
    },
    answer: "3",
    prerequisite: "command -v typescript-language-server",
  },
);

add(
  "lsp-rename",
  [
    "lsp.rename",
    "lsp.rename-cross-file",
    "lsp.rename-keeps-unrelated-names",
    "lsp.rename-refusal-recovery",
    "compose.symbol-read-rename",
    "compose.capture-uuid-source",
  ],
  'Use lsp_search with declaration task.ts#count. Try replacing its name capture with empty text; this must fail without changes. For this first replacement, pass path as {id: "<bare UUID>"}. In direct calls, take the issued name capture RESULT# reference and remove the RESULT# prefix. In Codemode, bind the lsp_search return value to result, take const captureId = result.matches[0].captures.name[0].id, then pass path: {id: captureId.replace(/^RESULT#/, "")}. The id field must contain only the capture UUID, with no RESULT# prefix. Then replace the same issued name capture with total to rename through LSP, using its original prefixed reference or capture value. The declaration, same-file usage, and import and usage in usage.ts must change. Keep the string and unrelated local count unchanged. Do not do an ordinary text replacement.',
  [
    { tool: "lsp_search", args: { declaration: /^task.ts#.*count$/ }, contains: "count" },
    {
      tool: "replace",
      args: {
        path: { id: /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u },
        text: "",
      },
      contains: "INVALID_REQUEST",
      excludes: "PLUGIN_FAILED",
      reuse: reuse(0, "path", "capture:name"),
      after: [0],
      error: true,
    },
    {
      tool: "replace",
      reuse: reuse(0, "path", "capture:name"),
      after: [1],
    },
  ],
  {
    files: {
      "task.ts":
        'export const count = 3;\nexport const doubled = count * 2;\nexport const label = "count";\n',
      "usage.ts":
        'import { count } from "./task";\nexport const answer = count;\nexport function unrelated() { const count = 7; return count; }\n',
      "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
    },
    expected: {
      "task.ts":
        'export const total = 3;\nexport const doubled = total * 2;\nexport const label = "count";\n',
      "usage.ts":
        'import { total } from "./task";\nexport const answer = total;\nexport function unrelated() { const count = 7; return count; }\n',
    },
    prerequisite: "command -v typescript-language-server",
  },
);

add(
  "lsp-overload-rename",
  ["lsp.overload-selectors", "compose.symbol-overload-rename"],
  "In main.cpp, ask lsp_search for the declaration main.cpp#clamp. It has several overloads; take the selector of the overload whose first parameter is a const Vec& from the result, and get that exact declaration, then rename it to clampVec by replacing its issued name capture (displayed capture reference or matches[0].captures.name[0] in Codemode). Its prototype, definition and the call with a Vec must change; the int overload and its calls stay unchanged. Do not do an ordinary text replacement.",
  [
    {
      tool: "lsp_search",
      args: { declaration: "main.cpp#clamp" },
      error: true,
      contains: "main.cpp#clamp(const Vec&, float, float)",
    },
    {
      tool: "lsp_search",
      args: { declaration: /^main\.cpp#clamp\(const Vec ?&, ?float, ?float\)$/ },
      after: [0],
    },
    {
      tool: "replace",
      after: [1],
      reuse: reuse(1, "path", "capture:name"),
    },
  ],
  {
    files: {
      "main.cpp":
        "struct Vec { float x, y; };\ninline int clamp(int v, int lo, int hi);\ninline Vec clamp(const Vec& v, float lo, float hi);\n\ninline int clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }\ninline Vec clamp(const Vec& v, float lo, float hi) { return {static_cast<float>(clamp(static_cast<int>(v.x), 0, 1)), v.y}; }\n\nint main() {\n  Vec v = clamp(Vec{1, 2}, 0.0f, 1.0f);\n  return clamp(3, 0, 2) + static_cast<int>(v.x);\n}\n",
      "compile_flags.txt": "-std=c++17\n",
    },
    expected: {
      "main.cpp":
        "struct Vec { float x, y; };\ninline int clamp(int v, int lo, int hi);\ninline Vec clampVec(const Vec& v, float lo, float hi);\n\ninline int clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }\ninline Vec clampVec(const Vec& v, float lo, float hi) { return {static_cast<float>(clamp(static_cast<int>(v.x), 0, 1)), v.y}; }\n\nint main() {\n  Vec v = clampVec(Vec{1, 2}, 0.0f, 1.0f);\n  return clamp(3, 0, 2) + static_cast<int>(v.x);\n}\n",
    },
    prerequisite: "command -v clangd",
  },
);

const callGraphSource = [
  "export function validate(value: number): boolean {",
  "  return value > 0;",
  "}",
  "",
  "export function save(value: number): boolean {",
  "  return validate(value);",
  "}",
  "",
  "export function submit(): boolean {",
  "  return save(1);",
  "}",
  "",
  "export function retry(): boolean {",
  "  return save(2);",
  "}",
  "",
].join("\n");
add(
  "lsp-calls-script-value",
  ["lsp.script-call-graph", "compose.lsp-caller-id", "lsp.script-line-text"],
  "In one Codemode call, use lsp_search with calls task.ts#save. Its value lists callers in incoming and callees in outgoing, each as its whole declaration. Check that the callers are submit and retry and the callee is validate. Then delete the caller retry by passing its incoming entry or that entry's id to delete, not a symbol or file path. Report the number of callers in plain digits.",
  [
    {
      tool: "lsp_search",
      args: { calls: "task.ts#save" },
      scriptResult: {
        complete: true,
        incoming: { length: 2 },
        outgoing: {
          length: 1,
          0: {
            path: "task.ts",
            line: 1,
            lineText: "export function validate(value: number): boolean {\n  return value > 0;\n}",
          },
        },
      },
    },
    { tool: "delete", args: { path: /^RESULT#[a-f\d-]{36}$/u }, reuse: reuse(0) },
  ],
  {
    modes: ["codemode"],
    files: {
      "task.ts": callGraphSource,
      "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
    },
    expected: { "task.ts": callGraphSource.replace(/export function retry[^}]*\}\n/u, "") },
    answer: "2",
    prerequisite: "command -v typescript-language-server",
  },
);

add(
  "read-media",
  ["read.image", "read.pdf"],
  "Use read to inspect sample.png, sample.pdf and recovered.pdf. Report the text marker inside the PDFs. Do not change files.",
  [
    { tool: "read", args: { path: "sample.png" }, image: true },
    { tool: "read", args: { path: "sample.pdf" }, contains: "PDF-MARKER" },
    { tool: "read", args: { path: "recovered.pdf" }, contains: "PDF-MARKER" },
  ],
  { files: {}, answer: "PDF-MARKER", setup: "media" },
);

add(
  "codemode-image-value",
  ["compose.codemode-image-value"],
  "In one Codemode call, read sample.png and show the returned image block with image(). Report its mimeType. Do not change files.",
  [
    {
      tool: "read",
      args: { path: "sample.png" },
      scriptResult: { type: "image", mimeType: "image/png" },
    },
  ],
  { modes: ["codemode"], files: {}, answer: "image/png", setup: "media" },
);

add(
  "read-image-write",
  ["compose.read-image-write"],
  "Read pixel.png, then save the image that Read returned to copy.png with Write: pass that Read result as Write image (its UUID in a direct call, the returned image value in Codemode). Do not use Copy and do not change other files. Report the written path.",
  [
    { tool: "read", args: { path: "pixel.png" }, image: true },
    { tool: "write", args: { path: "copy.png" }, reuse: reuse(0, "image") },
  ],
  { files: {}, setup: "pixel", expected: { "copy.png": pixelPng } },
);

const jsonText =
  '{"name": "demo", "ratio": 1.0, "tags": ["a", "b"], "quote": "say \\"hi\\"", "none": null}\n';
add(
  "write-json-text",
  ["write.json-text"],
  `Use Write to create data.json with exactly this JSON text, byte for byte, ending with one newline. Keep the spacing, the key order and the number 1.0 as written; do not reformat it:\n\n${jsonText}\nReport when it is saved.`,
  [{ tool: "write", args: { path: "data.json", content: jsonText } }],
  { files: {}, expected: { "data.json": jsonText } },
);

add(
  "web-read-search",
  ["web.read", "web.search"],
  "The local fixture server is at http://127.0.0.1:8765. Read its page as text, then search that URL for WEB-MARKER. Report the page marker. Do not change files.",
  [
    { tool: "read", args: { path: "http://127.0.0.1:8765" }, contains: "WEB-MARKER" },
    {
      tool: "search",
      args: { path: "http://127.0.0.1:8765", query: "WEB-MARKER" },
      contains: "WEB-MARKER",
    },
  ],
  {
    files: {},
    answer: "WEB-MARKER",
    setup: "web",
    resource: "web-port-8765",
  },
);

add(
  "json-structured-arguments",
  ["compose.json-text-structured-arguments"],
  'Pass structured arguments as JSON text strings, not native arrays or objects. Read a.txt and b.txt together using path equal to the string ["a.txt","b.txt"]. Search those same two files for MARKER with that JSON-text path list. Then use diff with before and after equal to JSON-text objects {"path":"a.txt"} and {"path":"b.txt"}; report the added marker. Finally diff again with JSON-text objects {"path":"a.txt","limit":0} and {"path":"b.txt","limit":0}; this must show no file lines. Do not edit files.',
  [
    { tool: "read", args: { path: ["a.txt", "b.txt"] }, contains: "OLD-MARKER" },
    {
      tool: "search",
      args: { path: ["a.txt", "b.txt"], query: "MARKER" },
      contains: "b.txt",
    },
    {
      tool: "diff",
      args: { before: { path: "a.txt" }, after: { path: "b.txt" } },
      contains: "NEW-MARKER",
    },
    {
      tool: "diff",
      args: { before: { path: "a.txt", limit: 0 }, after: { path: "b.txt", limit: 0 } },
      excludes: "MARKER",
    },
  ],
  { files: { "a.txt": "OLD-MARKER\n", "b.txt": "NEW-MARKER\n" }, answer: "NEW-MARKER" },
);
/** The same small tasks are used for every configured model. */
export const capabilityCases: CapabilityCase[] = cases;
