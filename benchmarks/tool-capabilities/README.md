# Paid tool capability matrix

This checks whether a real model can execute our designed IDE operations and tool chains. It is not a model ranking, a reliability score, or a replacement for unit and integration tests.

Each short task names the required route. The model must choose the arguments, use actual returned references, and produce the requested result. We check both final bytes or observed values **and** real tool execution events. Calling the same tool names without reusing the required results does not pass.

## Free checks

```bash
pnpm check:capabilities
pnpm validate:tools:models --list
```

The coverage gate is part of `pnpm check`. It loads the current IDE without a prompt or model call, compares structural tool contracts, and checks links between the declared capabilities and executable cases. It includes deferred tools, not just initially active tools. Descriptions and other prompt wording are not snapshot-tested.

The free regression tests cover route provenance and sandbox timeout/reset/cleanup. One scripted real-Pi integration test proves that nested Codemode events are read correctly. These tests do not use paid models.

## Paid runs

Requirements: Linux or WSL, Node 24, Git, Bubblewrap with user namespaces enabled, installed Pi with native Codemode and tool discovery, and provider credentials. The free inventory prefers the globally installed Pi; without one it uses the checkout's SDK. `--pi /absolute/path/to/pi` selects an installed runtime explicitly. Paid runs need Pi and its dependencies inside the read-only system toolchain mounts (`/usr`, `/opt`, or the local bin/lib directories under the user home).

On Ubuntu, AppArmor may also need a profile that permits user namespaces for `/usr/bin/bwrap`. CI loads that per-binary profile if a sandbox launch is blocked, then checks a real launch with user and PID namespaces. It does not disable the runner-wide restriction. See [Ubuntu's user namespace policy](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces).

```bash
pnpm validate:tools:models --run --model luna-6-low
pnpm validate:tools:models --run --model luna-6-low \
  --case read-search-replace --mode codemode --attempts 2 --timeout 120
```

No inference happens without both `--run` and an explicit model profile. The command is separate from ordinary tests and CI. Obtain permission for the selected provider, model, thinking level, and runs before using it. Being in `models.json` is not permission to spend.

Profiles use the Explicit Edit Benchmark registry as a starting point; Luna 6 low was added by explicit task approval. New models belong in `models.json`, not in case definitions. Use the same tasks and validators for each model.

Most cases have direct and Codemode routes. Cross-call `store`/`load` is Codemode-only. Cases are deliberately small: a representative route for each declared capability, not every Cartesian combination of tools, platforms, language servers, or debug adapters.
The `semantic-code-search` and `semantic-code-search-vera` cases select ColGREP and Vera respectively and initialize a small project index as their prerequisite. They check grouped project-wide files, a directory search with include and exclude filters, and a file-scoped range before reading the source. `semantic-vera-refresh` writes a new file and searches without a separate update command. The Vera scope case permits its documented best-effort scoped retrieval; it does not prove scoped-result completeness. Each case requires its engine and local model in the sandbox. If setup cannot complete within the prerequisite timeout, the route is unavailable rather than passed. Direct and Codemode routes for each engine remain unverified without a paid run.
Directory/link transfer cases cover the shared local policy and refusal to reuse an object receipt as text. SSH owner pairs are checked by focused integration cases, and Windows targets by an opt-in integration case that needs a real Windows host (`PI_AGENT_IDE_WINDOWS_SSH_TARGETS`); these paid cases do not prove paid SSH coverage. Unrun direct and Codemode routes remain unverified.

Temporary Delete and Move cases check exact nested names, roots themselves, replacement settings, and Copy merge behavior locally. Target-native account/config resolution is checked by transport tests, not a paid SSH case. Paid SSH temporary-removal routes remain unverified.

The `delete-policy-gates` and `directory-transfer-gates` cases check fail-closed approval without a user UI, unchanged targets, and a permitted Read after refusal. Their direct and Codemode routes remain unverified until paid execution.

The `filesystem-yolo` case explicitly enables the filesystem setting and checks headless Delete/Move, a protected Git-path refusal, and a permitted Read. It checks confirmation bypass without removing technical guards. Its direct and Codemode routes remain unverified until paid execution.

IDE filesystem, GitHub and Linear approvals use the shared operation dialog. Terminal waiting, serialized dialogs and lifecycle cleanup belong to focused real-Pi and live Herdr checks, not this headless runner. These paid cases do not establish provider approval coverage, prove the header or answer a user dialog; GitHub raw REST/GraphQL YOLO remains outside the approval policy.

The `ssh-guide` case checks that Read exposes SSH setup guidance before any target is configured. It does not verify connection setup, reload, or remote operations. Its direct and Codemode routes remain unverified until a paid run.

The Codemode-only `shell-script-value` case checks that a script reads `exit_code` and `output` of a command that exits non-zero from the returned object, and deletes a background session through its `session` field. Truncation of long output and a command that cannot start are covered by `shell-result.integration.test.ts`, not a paid route. `powershell`, `remote_bash` and `remote_powershell` share the same value; only `bash` has a paid route. Its route remains unverified until paid execution.

`remote_powershell` and `remote_bash` exist only when an SSH target of the other OS is configured, so the free inventory never lists them and no paid case covers them. The free inventory loads the IDE from an empty agent directory and project, so your own `ssh.json` targets and IDE settings do not change the gate. Registration and working-directory rules are checked by focused unit tests, and execution on a Windows target by live checks. Their direct and Codemode routes remain unverified.

The `debug-backend-fallback` case checks the explicit VS Code refusal and recovery through the native backend; the sandbox has no VS Code. Debugging through VS Code and DebugMCP needs the user's running VS Code window, so it is checked live, not by a paid route.

Resumed tool loadouts are host lifecycle, not a model route. On Pi 1.3.0 and newer, Pi restores discovered tools and applies CLI `+name`/`-name` selections; the deterministic `ide-exposure` real-Pi cases check that the IDE keeps those choices and its exclusions. The `discovery.*` capabilities stay fresh-session routes.

The `compose.shell-first-use-input` and `compose.debug-first-use-controls` capabilities use fresh-session roundtrips after deferred terminal/debugger metadata becomes available. Bash activates terminal guidance on first use. Native `tool_search` activates debugger guidance from its loaded results; Codemode `searchTools` and `describeTool` do not activate it until an actual debug call. These paid routes validate the follow-up operations and reference reuse. Deterministic real-Pi cases check schema publication, composition, restoration and exclusions; a paid route does not inspect serialized schemas or prove cache savings. Unrun direct and Codemode routes remain unverified.

## Connector runs

Use one connector per invocation. `connectors.ts` pins the package identity, version, entrypoints, provider and prerequisites. When a connector delegates authentication, `authProvider` names the actual credential owner separately from its model provider. The runner guards that owner without copying credentials into another provider key. Stage the connector outside the source tree with lifecycle scripts disabled before the run. The runner never installs a connector during an attempt. `--connector-root` points to the staging prefix containing `node_modules`; its lockfile and dependency-tree digest become evidence.

Start with a free load check:

```bash
node benchmarks/tool-capabilities/cli.ts --preflight --pi /usr/bin/pi \
  --connector subscription-connector --connector-root /path/to/staged-prefix
```

Preflight rejects model selections and real authentication inputs. It uses synthetic credentials, a private home and a separate network namespace. It records declared providers, tools and load failures without sending a prompt. `loaded` means startup completed, not that inference or tool compatibility passed. Historical packages excluded by the catalog report `unavailable` without launching a child.

For a paid attempt, select an approved profile with the connector's provider:

```bash
node benchmarks/tool-capabilities/cli.ts --run --pi /usr/bin/pi \
  --model haiku-4.5-low --connector subscription-connector \
  --connector-root /path/to/staged-prefix --auth-dir /path/to/private-pi-snapshot \
  --case read-search-replace --mode codemode --attempts 1 --timeout 120
```

SDK/CLI connectors also need `--claude-executable /absolute/path/to/claude`. When they use Claude Code authentication, supply `--claude-state /path/to/private-claude-config`. The selected executable is hashed and mounted read-only. These children run as a non-root user inside their namespace; the host user is unchanged.

Use only approved private authentication state. Snapshot mode stages access material without refresh tokens and rejects tokens that expire before the attempt plus its safety window. For a separately authorized private Pi OAuth login, add `--dedicated-auth` with `--auth-dir`: only its `auth.json` is mounted writable, refresh rotations persist across attempts, and an exclusive lock prevents concurrent runner use. This mode rejects personal paths, unsafe or linked files and credentials for unrelated providers. Initial and rotated secret values are suppressed before evidence export.

The pinned `claude-auth` connector uses a different file-auth mode: supply `--claude-state` with its dedicated private Claude credential directory, but omit `--claude-executable` and `--dedicated-auth`. The runner locks and mounts only the selected credential file writable, preserves rotations, and audits both that file and the connector-seeded case-private Pi auth. Its hidden Claude CLI inference fallback is blocked; attempting it makes the route unavailable, not an untracked paid helper request. This mode does not support connectors that replace the credential file with an atomic rename.

The runner does not log in, move credentials between provider keys or enable extra usage. Separate-provider OAuth logins must be completed through that connector's own login flow before selecting its auth directory. SDK/CLI environment authentication remains access-only. Filesystem isolation does not isolate the subscription account from quota use or restrictions, and a subscription indicator does not prove how the backend bills a request.

Pi automatic retries are disabled. SDK/CLI internal retries are not independently bounded by this setting. Account, quota, billing or authentication errors stop the remaining batch. Requested and runtime identity, assistant metadata and any reported response model are retained separately. If a provider does not report its response model, backend identity remains unobserved. Use `servedModel` in a profile for a documented model alias, not to hide fallback.

Alias validation keeps raw names and events. A local wrapper passes only when its provenance, arguments, real IDE child, result and required reference reuse match. Foreign MCP names are not stripped into native tool names. `semantic-script-receipts` checks object values through a script call; `semantic-local-alias-receipts` additionally requires an actual local alias and skips connectors without one.

## Live terminal comparison

Add `--tui` inside a real terminal to inspect native Pi rather than JSON output. Select exactly one model, case, route and attempt. Use the same case and terminal dimensions for the native baseline and connector. The timeout includes time spent inspecting the completed screen. Exit with `/quit` after capturing it.

Add `--tui-history` to save the actual native session and reopen it after the first `/quit`. The second stage has no prompt, uses a separate network namespace, and rejects agent/provider work. Its footer shows `LPT769_HISTORY_RESTORED`; capture the restored cards, then `/quit` again. Each stage has its own bounded inspection timeout. First-stage route validation stays separate from history validation, and retained session evidence crosses the same secret-redaction boundary as other artifacts.

The runner mirrors public lifecycle, finalized-message and execution events for route validation. It does not capture screenshots or streaming deltas in TUI mode. Capture the actual terminal separately and retain it with the Task. Check running and completed states, expanded history, errors and media where relevant; a headless pass or a completed panel alone does not establish visual parity. Inherited terminal output is not live-redacted: do not enable connector debugging that prints secrets.

## Isolation

A run freezes the checkout's current source and dependencies in a disposable clone and records its revision and source digest. Each case gets a fresh clone, fixture directory, private Pi home, and process namespace. Only that case's workspace/state and sandbox temporary directories are writable. Source and system tools are read-only; host checkouts, personal context, extensions, skills, and MCP configuration are not loaded.

Network access is shared for inference and local web fixtures. This is **not** network isolation or a sandbox for hostile code. Snapshot credentials are copied into private case state and removed with it. Explicit dedicated-auth files are mounted separately and survive cleanup with their refresh rotations. Child process groups are stopped on timeout/cancellation. Cleanup never runs `git reset` or `git clean` on the development checkout.

Media, browser, LSP, and debug cases need their own system prerequisites. Missing prerequisites produce `unavailable`, never a pass. Web setup uses a fixed local endpoint; do not run those cases concurrently.

## Evidence

Each invocation creates a new directory under `.tmp/capability-results/`, or a new directory selected with `--results`. Existing directories are not overwritten.

- `matrix.md`: capability × model/route evidence with links to every attempt.
- `manifest.json`: live inventory, selected profiles/cases, base revision, source digest, timeout.
- `attempts.json`: all attempts, including failures.
- Per attempt: prompt, JSONL events, stderr, actual model/thinking and system prompt, initial/final fixture bytes (`files.json`, Base64), result, and tool errors when execution reached validation.

`pass` means the required route and outcome were observed. `route_failed`, `outcome_failed`, `model_error`, `infra_error`, `timed_out`, `cancelled`, and `unavailable` remain distinct. Not run is not a pass. A later success does not erase earlier failures. An observed pass proves executability once, not consistency across runs.

Reports are written after each attempt and preserved on cancellation. Case workspaces and credentials are removed even when a case fails. Review evidence before sharing it: it includes prompts and tool results. Preserve the accepted report and source digest with the task before removing the development worktree. Results from different source digests must not be presented as one run of the same code.

Live semantic engine switching and reload-required settings are session lifecycle behavior, not a model route. The focused `live-settings.integration.test.ts` drives the settings menu in real Pi; the existing semantic cases still cover execution and scoped results for each pre-indexed engine. They do not establish paid coverage of live switching, and unrun routes remain unverified.

The current `ui.codemode` setting is an Off/On switch for extra IDE result panels only. Native Codemode rendering is unchanged. The focused `compact-codemode.integration.test.ts` cases check default suppression, per-tool presentation, expanded history and retained errors. Existing `codemode.silent-write`, `codemode.parallel-edit-effects`, `codemode.store-load`, `compose.cross-call`, and `ide-settings-catalog` cases still cover unchanged execution and model data; this TUI change adds no paid route.

Late diagnostic ownership is UI metadata, not a new model operation. The existing diagnostic-read, write/read and parallel-edit cases still cover the unchanged tools and model results. Revision-bound ownership, deferred completion and native presentation are checked by the focused linked-diagnostics integration case, not by a new paid route.

Advisory-review ownership is also display metadata. The matrix and write/read and parallel-edit cases retain their existing model-operation contracts; no new paid operation is introduced. Focused reviewer and real-Pi linked-review cases cover saved-version ownership, direct and nested calls, and unchanged full review delivery. Stereo Rows/Columns checks require `PI_AGENT_IDE_TEST_STEREO_EXTENSION` to point to an unchanged consumer extension; without it those cases are skipped, not verified.

Delayed terminal ownership also changes presentation metadata, not a model operation. The existing `shell-roundtrip` direct and Codemode routes cover the unchanged Bash, input and inspection contract. Mixed-owner delivery, nested visible roots, reload gaps and stale notices belong to the focused terminal tests; `linked-terminal.integration.test.ts` checks real-Pi persistence and optionally unchanged Stereo panels/search. No new paid route is needed for card grouping. Unrun paid routes remain unverified.

Optional provider error metadata changes the shared result schema, including tools that do not emit that metadata. The semantic receipt cases still require the original effect and attempted/delivered fields. Focused ResourceError, Read and Write tests exercise rate-limit metadata delivery and private-field removal. Write retains the closed metadata on each owning file diagnostic and revalidates it for the structured result without changing mutation effects. These paid cases do not establish rate-limit metadata coverage; unrun direct and Codemode routes remain unverified.

Search and `ast_search` on a result whose file other sessions changed read the current text of the selected region and say so. `lsp_search` with a result scope follows the region onto the text it reads its hits from when another session writes the file before or while the server answers, and asks for references at the position the declaration has in the text the server holds. That needs a concurrent writer, so focused result-store, Search-core, AST resolver, LSP resolver and symbol-search tests cover it, with `lsp-reference-writer.integration.test.ts` for a complete reference list and a rename from it in real Pi, not a paid route. The existing `ast-capture-rename` and `ast-search-enclosing` cases still cover the unchanged-result routes; their direct and Codemode routes remain unverified until paid execution.

A `search` whose matched file another session writes between the backend run and the registration of its anchors registers the matches of the text it captured, so every match a result shows keeps its anchors and the whole result stays usable as an edit source; a source that cannot be read at all is left out with a notice. That needs a concurrent writer, so the focused `search-registration-race` tests and the real-Pi `search-concurrent-writer.integration.test.ts` stress case cover it, not a paid route. The existing `read-search-replace` case still covers the unchanged single-writer route; its direct and Codemode routes remain unverified until paid execution.

The possible names a `search` offers when it finds nothing register the same way: each candidate's matches are captured with the text of its files and registered from that text, within the candidate byte and match limits, so a candidate keeps its anchors while another session writes its file; a candidate whose file cannot be read or exceeds the byte budget is still shown without stable references and says so. That needs a concurrent writer, so the focused `fuzzy-fallback` tests and the possible-name case of `search-concurrent-writer.integration.test.ts` cover it, not a paid route.

A Read of a `RESULT#` selection tolerates a concurrent local-file write outside the selection, mapping the selection onto the text acquired by Read; it rejects a selection whose text changed. The focused result-anchor tests and `search-concurrent-writer.integration.test.ts` exercise this timing and the changed-selection guard. The existing `read-search-replace` executable case covers the unchanged single-writer composition, not this race; its direct and Codemode routes remain unverified until paid execution.

A Read of a search reference whose file another session wrote after the reference was resolved moves each selected range onto the text the Read acquired, so it shows the matched lines and not the lines that now stand at their old numbers; a range whose own text changed fails and says where it stands. An all reference whose file changed since the search searches again and captures the text it checks those matches against, so a writer between the two no longer fails it. Both need a concurrent writer, so the focused `read-tool` and `search-registration-race` tests and the Read case of `search-concurrent-writer.integration.test.ts` cover them, not a paid route. The existing `read-search-replace` case still covers the unchanged single-writer route; its direct and Codemode routes remain unverified until paid execution.

`ast_search` registers the anchors of its matches and captures from the text ast-grep parsed, so another session writing the file between the search and the registration no longer fails the call, and a file that keeps changing past the bounded retries says so. That needs a concurrent writer too: the focused AST resolver tests and the real-Pi `ast-concurrent-writer.integration.test.ts` case, which runs `ast_search` followed by `replace` with the whole result against a writer, cover it instead of a paid route. The existing `ast-capture-rename` and `ast-search-enclosing` cases keep the unchanged single-writer routes, which remain unverified until paid execution.

`lsp_search` registers the anchors of its symbol hits from the text it mapped them onto, so another session writing the file between the server's answer and the registration no longer makes the call search again. That needs a concurrent writer as well: a focused LSP resolver test that writes the file in that window covers it, and `lsp-reference-writer.integration.test.ts` keeps the reference list, result scope and whole-result rename working in real Pi under a writer, not a paid route. The existing `lsp-read` case keeps the unchanged single-writer route, which remains unverified until paid execution.

An all-match anchor whose search must run again after other edits, and the reasons it gives when it cannot, also need a changed or concurrently written file. Focused search-session, AST resolver, anchor-registry and retry tests cover them, with `all-match-refresh.integration.test.ts` for a scoped `lsp_search` refresh in real Pi and a limited anchor's reason; no paid route is added. The existing `read-search-replace`, `ast-capture-rename` and `lsp-read` cases still cover the unchanged search and edit routes; their direct and Codemode routes remain unverified until paid execution.

A retry of the same all-match edit moves the matches its earlier attempt found instead of searching again. That too needs a concurrent writer, so focused search-session retry and text-change tests cover it, not a paid route; the cases above still cover the unchanged single-writer routes, which remain unverified until paid execution.

A native Codemode edit batch whose file another process changes is planned again on the current text, and a call whose anchor is gone fails alone. That also needs a concurrent writer, so the focused real-Pi cases in `native-codemode.integration.test.ts` cover it, not a paid route. The existing `codemode.parallel-edit-effects` case still covers the unchanged single-writer batch; its routes remain unverified until paid execution.

The `search-path-list` and `lsp-path-list` cases pass two directories as one `path` list to `search`, `file_search`, `ast_search` and `lsp_search`, in either order, and require that a third directory stays out of the results; `lsp-path-list` needs typescript-language-server. Overlapping paths, mixed lists of paths and results, and lists of SSH paths are covered by the focused `search-path-list` and `ssh-search-path-list` integration cases, not a paid route. Their direct and Codemode routes remain unverified until paid execution.

The `lsp-overload-rename` case needs clangd. It requires a failed `declaration` for an overloaded name whose error lists a selector per overload, then a `symbol:` rename with the selector of one overload; the other overload's calls must stay unchanged. Listing overloads in `lsp_search` while clangd's index lags behind another session's writes needs a concurrent writer, so focused symbol-search tests cover it, not a paid route. Its direct and Codemode routes remain unverified until paid execution.

In Codemode, `lsp_search` `query` and `declaration` return the same `{ id, complete, matches }` as Search, and `calls` returns `{ id, complete, matches, incoming, outgoing }` with each caller and callee as its whole declaration. The Codemode-only `lsp-calls-script-value` case checks the callers and callee of a function and deletes one caller by its `incoming` entry; it needs typescript-language-server. Merged file call graphs, lists past 100 entries and incomplete C/C++ coverage are covered by focused LSP resolver and value tests, not a paid route. `read-symbol-delete` accepts the declaration value or its match on its Codemode route. These routes remain unverified until paid execution.

The `read-jq` case includes a transformed output window. `read-jq-bounded-input` requires refusal when a jq query is given an issued selection, followed by a permitted query of the explicit source. These cases cover the shared filesystem calling contract. Provider-registered structured JSON and the public jq handler are covered by focused SDK and consumer tests, not by a paid Linear route. Those direct and Codemode provider routes remain unverified; no inference is required for the free gate.

A text Read inside Codemode returns `{ text, id }` with the whole requested text, so the AST overview is a direct-route behavior only: the `read-overview-search-*` cases have no Codemode route. `read-large-store` stores an exact window larger than the model output limit and searches it again after the edit. `read-large-json-script` parses a large JSON file in a script and writes it back. Their routes remain unverified until paid execution.

The `read-error-direct` and `read-error-codemode` cases also check a declared failure for a complete fragmented provider address. They require a failed Read and exactly one full-address acquisition, even though its bare source is readable. In Codemode, each failed Read resolves to `null` and the script result lists it with its source; the task tells the model not to catch errors. The independent missing-file error and successful file read remain controls. These direct and Codemode routes remain unverified until paid execution.

The `diff-script-complete` case diffs a file with more lines than a tool result shows in a Codemode script and requires the complete unified diff as the script value, then an empty string for equal sources; `read-diff` and `diff-omission` also check the diff value. These routes remain unverified until paid execution.

The `value-id-source` case passes objects with an `id` as Search's and Replace's `path` in one Codemode call; a route reuses a result when an object's `id` is `RESULT#` with that result's UUID. Search gets the Read value `{ text, id }` itself and Replace the Search value itself. Direct calls with such an object, arrays of them, ignored fields and unknown ids are covered by the focused `source-value-schemas` and `codemode-source-values` tests, not a paid route. Its Codemode route remains unverified until paid execution.

In Codemode, Search and `ast_search` return `{ id, complete, matches }` with an `id` for each match and capture, and no numbered `SEARCH#` references. A route reuses a prior result when a passed id is the envelope UUID of its readable result or any `id` in its script value. `search-script-facts` checks the match list and `complete` of empty, bounded and complete searches. `search-script-match-ids` lists 150 matches, more than a readable result shows, and replaces only the last one by its id. Cases that pass `:match` references accept a match id on their Codemode route. `search-issued-scope`, `insert-search-anchor-list` and `mixed-range-replace` use `:all` or `:line` selectors that only readable results issue, so they keep only their direct route. These routes remain unverified until paid execution.

The `token-search-edit-guard` case checks that a whole result from a search broadened to separate words cannot be replaced, while an individual Boolean match and a quoted literal result remain editable. The direct and Codemode routes remain unverified until paid execution.

The `write-json-text` case checks that Write saves JSON text byte for byte, including `1.0`, spacing and escaped quotes. Its direct route matters most on Anthropic models: their tool-call layer converts parameter text by the declared schema, so a field that also accepts objects would receive JSON text as an object. Providers that pass the model's JSON arguments unchanged do not exercise that conversion. `read-image-write` passes the image through Write `image`, not `content`.

## Required maintenance

When an IDE tool or a supported composition changes:

1. Review `matrix.ts`. Add, update, or remove the intended capability entries.
2. Update the linked tasks in `cases.ts`, including their route and outcome checks. Include every required source/destination reference, not just one endpoint.
3. Run the free gate and affected free regression tests.
4. If the tool schema changed, review the cases first, then explicitly record the new contracts:

   ```bash
   pnpm validate:tools:models --record-contracts
   pnpm check:capabilities
   ```

5. With paid permission, run the affected routes and preserve both failures and successes. Leave unrun routes unverified.

The schema gate detects structural drift and broken coverage links. It cannot infer semantic completeness or detect every behavior change from code. Do not just regenerate `contracts.json` to bypass a failure; the matrix/case review is mandatory even when the schema stays unchanged.
