---
name: testing-pi-agent-ide
description: Write and run real-Pi integration tests whenever changing Pi Agent IDE behavior: new features, bug fixes, and tool ergonomics. Use this skill even when unit tests pass; test the real tool contract, and test native TUI rendering when the user-visible output changes.
---

# Test Pi Agent IDE in real Pi

Every new feature and fixed regression needs a test in the repository's integration suite. Unit tests help isolate the cause, but they do not replace a real-Pi test. Add the test alongside the closest scenario in `tests/integration/`; do not create a second runner or mock Pi's loader, tools, agent loop, session, or terminal.

Before writing the test, inspect a neighboring `tests/integration/` test and the package's own example tests when available. Do not assume globally installed skills are present. Use `PiIntegrationTest` with the real `src/pi-agent-ide.ts` extension, explicit tools, an isolated fixture, a scripted provider conversation, and `testArtifactsDir(import.meta.filename)`.

## Choose the observable surface

- For a tool contract, use the default raw mode. Assert the returned tool result or error *and* the external effect (file bytes, state, ordering, or other observable data). A scripted tool call alone does not prove anything ran. Keep expected bytes explicit, especially for newline or encoding bugs.
- When the user-visible renderer, layout, animation, or terminal status changes, run with `rawMode: false` and assert the native terminal result as well as the structured tool result in the same run. Inspect recorded terminal frames when timing or intermediate presentation matters. Do not substitute model-facing results for terminal evidence.
- Keep pure data transforms in unit tests as additional coverage. Do not assert wording of prompts, Markdown guides, descriptions, or explanatory prose.

For external services or hardware unavailable in ordinary CI, name the dependency and document a narrow exception. Put a real live check in a separate runnable path; never call a mocked Pi test a full integration test. Keep the deterministic local real-Pi contract in CI where possible.

Run the focused file with `pnpm test:integration -- <path>` (or the suite's current equivalent), then run the integration gate used by the release candidate. Read failures and saved artifacts before changing assertions. Preserve the regression test with the feature; do not leave verification as a one-off manual run.
