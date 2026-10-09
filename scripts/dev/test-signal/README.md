# test-signal advisory audit

This experiment runs `eslint-plugin-test-signal` 1.2.14 with Oxlint 1.87.0.
It enables all 25 stable rules as warnings for test files only. It does not
change the normal lint config, CI, package scripts, or existing tests. No fixes
are applied.

## Run it

From the repository root:

```sh
mkdir -p .tmp/test-signal
pnpm exec oxlint --config scripts/dev/test-signal/audit.config.ts --format json . > .tmp/test-signal/scan.json
```

Warnings do not fail this command. The JSON keeps each rule, message, source
file, and location. Review those warnings before treating them as defects.

## Tooling changes

- Oxlint and `@oxlint/plugins`: 1.79.0 → 1.87.0.
- `oxlint-tsgolint`: 7.0.2001 → 7.0.2003, matching Oxlint's peer requirement.
- Added `eslint-plugin-test-signal` 1.2.14.
- Added TypeScript 6.0.3 for the plugin's typescript-eslint parser. Resolving
  that peer to the existing native TypeScript 7 alias made the plugin fail to
  load. The native compiler dependency remains unchanged.
- Moved one existing `no-unsafe-return` suppression in `text-mutation.ts` to
  match the new diagnostic location. No runtime code changed.

Normal lint, type-check, formatting of changed files, and the custom prose
rule's 29 RuleTester cases pass. The install still reports the existing
Vite/esbuild peer mismatch; those dependencies were not upgraded here.

## Repository scan

The scan visited 857 files and returned **887 warnings in 170 test files**,
with no error diagnostics. Counts are diagnostics, not distinct defective
tests. Some rules report the same callback twice.

| Rule                             | Warnings |
| -------------------------------- | -------: |
| require-assertions               |      335 |
| no-empty-async-tests             |      334 |
| require-negative-path            |       90 |
| no-conditional-assertions        |       46 |
| no-duplicate-assertions          |       31 |
| no-fixed-delay-tests             |       18 |
| no-weak-existence-assertions     |       15 |
| no-mock-call-only-tests          |        9 |
| require-awaited-async-assertions |        5 |
| no-try-catch-assertions          |        3 |
| no-weak-truthy-assertions        |        1 |

The other 14 rules returned no findings. This is not a full review of all
887 warnings.

## Reviewed findings

- **Fixture callbacks:** `rollback-outcomes.integration.test.ts:23` awaits
  `withTempWorkspace`, whose callback contains assertions at line 65 onward.
  Both assertion-presence rules report the outer test anyway. The upstream
  scanner deliberately skips nested functions other than immediately invoked
  functions. Neither rule has an option for our fixture helpers. The 669
  presence warnings are therefore a noisy group, not 669 proven empty tests.
- **Saved assertion promises:** all five async-await warnings are false
  positives. Each promise is stored and later awaited, often after cancellation
  or advancing timers. Locations: `tests/post-edit/diagnostic-protocol.test.ts:137`,
  `src/api/tool-config.test.ts:71`, `src/core/diagnostic-store.test.ts:264`,
  `src/extensions/pi-agent-search/src/core/search-timeout.test.ts:13`, and
  `src/plugins/pi-agent-ide-lsp/src/lsp/diagnostics.test.ts:185`.
- **Duplicate assertions:** `registry.test.ts:110,121` checks the same UI hints
  or render request before and after state changes. These are separate phases,
  not redundant assertions.
- **Fixed delays:** `resource-scheduler.test.ts:106,131` uses timeout guards
  around a race to catch hangs. These are not sleeps used to wait for success.
- **Try/catch:** `text-anchor-registry.test.ts:159,163,165` explicitly throws
  when the operation unexpectedly succeeds; the catch checks the error type.
  Its assertions do not silently disappear on a successful operation.
- **Mock-only:** `tests/post-edit/gate.test.ts:145` tests that non-file edits
  never invoke formatter detection. The absence of that call is the intended
  observable contract, not an accidental lack of outcome checks.
- **Existence:** `catalog.test.ts:44,46` checks that verified languages have
  recipes and that advertised recipes have debugger metadata. Existence is
  part of that contract; other assertions check the metadata.
- **Conditional assertions:** the rollback test chooses assertions for native
  versus standalone tool result shapes. Branching is deliberate here.
- **Truthy assertion:** `shell-result.test.ts:33` could assert a more specific
  error value, but the current test already checks failure status, output,
  truncation, and absence of an invented exit code. This is a review candidate,
  not proof that the test passes without checking behavior.
- **Negative paths:** the rollback file is reported as lacking a negative path
  despite exercising injected write failures and checking an error result.
  The rule's recognized matcher signals do not cover every failure contract.

## Controlled CLI check

A temporary file with five fabricated test snippets was scanned through the
real Oxlint CLI with the same 25 rules:

| Snippet                                                   | Result                        |
| --------------------------------------------------------- | ----------------------------- |
| Prompt getter checked against a full instruction sentence | No warning                    |
| `expect(renderText()).toContain("")`                      | Vacuous-string warning        |
| Assertion inside an awaited fixture callback              | Two false presence warnings   |
| `.rejects` saved to a variable and later awaited          | False missing-await warning   |
| `.resolves` genuinely not awaited                         | Correct missing-await warning |

The check produced exactly five warnings in one file. The instruction was
invented for the experiment, not copied from a production prompt. This was a
lint check, not execution of the fabricated tests.

## Conclusion

Do not enable the full preset automatically. It catches some weak assertions,
but our fixture helpers, staged async assertions, timeout guards, and
multi-phase tests produce false positives.

It also does **not** solve LPT-115's prose-coupling problem. The vacuous-string
rule catches assertions that match every string, not assertions that pin a
meaningful but editable instruction sentence. Keep this audit separate from
the custom prose detector. Any enforced subset needs its own review and user
approval.

Sources: the installed plugin's rule docs and `dist/_internal/test-ast.js`,
plus the real repository scan and controlled CLI check. Upstream docs:
<https://github.com/Nick2bad4u/eslint-plugin-test-signal>.
