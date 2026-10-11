# Settings skill smoke

These are focused real-agent checks for the shipped `configure-agent-ide` skill. They are not the paid tool capability matrix. [LPT-676 evidence](../../tool-capabilities/evidence/LPT-676.md) retains historical results and a raw archive for the earlier compact/full setting. Those results do not verify the current off/on setting or the explanation-only scenario.

## Prepare an isolated case

Use an ignored `.tmp` directory. Give each case its own workspace and agent directory. Put Project settings in `workspace/.pi/pi-agent-ide/extensions.json` and Global settings in `agent/pi-agent-ide/extensions.json`. Include unrelated preferences and unknown fields so preservation is observable.

The prompts and expected outcomes are in `evals.json`:

- Show extra IDE results: start with Project `ui.codemode=off` and Global `off`; expect only Project to become `on`.
- Default and already-matching: start with Project `on` and Global `off`.
- Ambiguous scope: both scopes start with `off`.
- Disabled documentation: Project also disables `ide.documentation`.
- Explanation only: use either saved value and require no mutations or reload. Review the explanation manually rather than asserting prose.

Save the selected prompt in a UTF-8 file. Do not use personal settings as fixtures. Use a new results directory for every attempt; the runner refuses to overwrite one.

## Run

Start without inference:

```bash
pnpm exec oxnode scripts/live-settings-skill.ts \
  --ide <canonical-develop-checkout> \
  --workspace <private-workspace> \
  --agent-dir <private-agent-directory> \
  --results <new-results-directory> \
  --prompt <prompt-file>
```

The runner fetches develop, rejects a dirty or outdated IDE checkout, loads its extension and skill, and records actual source identity. It uses existing official authorization without copying credentials. The private agent directory holds only isolated settings.

Add `--run` only with explicit permission for `openai-codex/gpt-6-luna`, thinking `high`. Add `--without-skill` for a same-prompt baseline. Paid attempts have a four-minute timeout and no automatic model retries.

## Judge outcomes

A settled model turn is not a passing scenario. Inspect tool events, responses and before/after bytes and modification times. Check scope, unknown-field preservation, no-op behavior, clarification, pending reload and disabled modules. Retain unsuccessful calls and failed attempts.

After a change, run again without `--run` in the same fixture, using a fresh results directory. `startup.json` records `nativeCodemodeUnchanged` and rejects an IDE renderer that changes the native Codemode script marker. This startup probe does not verify the IDE panel switch or capture a human TUI viewport. The deterministic rendering integration in `tests/integration/compact-codemode.integration.test.ts` checks the panel switch and per-tool presentation. Baselines are individual observations, not a statistical reliability claim.

The tool guard blocks outside writes and unrelated tools, but it is not an OS sandbox. The CLI flushes evidence before exiting because SDK services may retain process handles. The importable runner does not terminate its caller.
