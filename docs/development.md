# Development

## Requirements

- a current Pi installation with `pi` on `PATH`;
- Node.js and pnpm;
- Git.

## Set up a checkout

```bash
git clone https://github.com/alexshpunt/pi-agent-ide.git
cd pi-agent-ide
pnpm install
```

## Run the unified extension

The root package uses the same single entrypoint as the published package:

```bash
pi --no-extensions -e .
```

`--no-extensions` prevents an already installed copy from loading at the same time. Explicit `-e` extensions still load.

Use the project config at `.pi/pi-agent-ide/extensions.json` to disable built-ins or turn on built-ins that are off by default for this checkout. A global config can be placed at `~/.pi/agent/pi-agent-ide/extensions.json`.

## Run modular mode

Modular mode loads every built-in through its independent source entrypoint:

```bash
pnpm dev:modular
```

Use this mode when working on plugin ordering, package boundaries, or failures that should be isolated to one Pi extension. The modular manifest contains the ordered entrypoint list.

The published package uses the composite entrypoint because loading dozens of Pi extensions separately is noisy for normal use.

## Test

Run unit tests after changing a covered component:

```bash
pnpm exec vitest run --config vitest.config.mjs
```

Run real-Pi integration tests after changing extension loading, tools, hooks, sessions, rendering, or filesystem behavior:

```bash
pnpm test:integration
```

Integration tests use `pi-coding-agent-test`. They start real Pi processes with scripted model responses and preserve traces and terminal artifacts under `.tmp/test-runs/`.

### Watch integration tests live

Use the project command to watch every test in one file:

```bash
pnpm test:integration:live -- \
  tests/integration/path/to/example.integration.test.ts
```

Use the explicit named-test command when you only want one test:

```bash
pnpm test:integration:live:test -- \
  tests/integration/path/to/example.integration.test.ts \
  "shows the expected result"
```

Both commands repeat the test until you press `Ctrl+C`. They use the `gpt-5.6-sol-xhigh` stream profile and wait 1000 ms between runs.

Override either default after the file or test name:

```bash
pnpm test:integration:live -- \
  tests/integration/path/to/example.integration.test.ts \
  --stream-profile gemini-3.5-flash \
  --pause-ms 500
```

Add `--once` for one run. Add `--delay-ms 17` to use a fixed delay instead of a stream profile.

VS Code provides two launch targets under **Run and Debug**:

- **Watch integration test file live** asks for a file and runs every test in it;
- **Watch named integration test live** also asks for the test name.

Both targets run the matching project command in the integrated terminal.

You can also call `pi-test` directly when you need full control over the wrapped test command:

```bash
pnpm exec pi-test live \
  --stream-profile gpt-5.6-sol-xhigh \
  --pause-ms 1000 \
  -- \
  vitest run tests/integration/path/to/example.integration.test.ts \
  -t "shows the expected result" \
  --config vitest.integration.config.mjs
```

Completed runs leave terminal records under `.tmp/test-runs/`. Replay a recorded case without running its tools again:

```bash
pnpm exec pi-test replay ".tmp/test-runs/path/to/test/case"
```

Use the exact artifact directory reported by the test run. Add `--play` to play the recorded terminal frames.

Check package paths before committing:

```bash
pnpm check:paths
```

## Build the public package

Build and validate the single publishable tarball:

```bash
pnpm package:public
```

The result is written to `.agents/tmp/public-package/`. The tarball contains the umbrella extension and its private workspace packages as bundled dependencies. Tests, development files, hooks, temporary files, and private package metadata are excluded.

Only the `pi-agent-ide` tarball is intended for registry publication. The bundled package names are implementation details and are not published separately.

The release runs compiled JavaScript from `dist/`. Its public entrypoints share generated chunks, so the extension and plugins use the same runtime modules. Source files remain for TypeScript consumers and module-relative resources. Development still loads `src/pi-agent-ide.ts` directly. PDF, browser, and HTML extraction dependencies load on first use instead of during startup.

To check an installed tarball, create a clean directory outside the checkout and install it with production dependencies. Pass that directory (the parent of `node_modules`) to the package integration tests:

```bash
PI_AGENT_IDE_TEST_INSTALLATION=/path/to/installation \
  pnpm exec vitest run --config vitest.integration.config.mjs \
  tests/integration/composite/release-runtime.integration.test.ts
```

These checks exercise first-use resources, browser fallback against a local page, external plugins, reload, and prompt parity. They need a system Chrome or Chromium executable. The package-specific suite is skipped when no installation is supplied.

Compare baseline and candidate installations using the same Node and Pi versions:

```bash
node scripts/measure-startup.ts \
  /path/to/baseline/extension-entry \
  /path/to/candidate/extension-entry \
  .agents/tmp/startup-comparison
```

Use the entry declared in each installed package's `pi.extensions`. The script records an initial run separately, then five interleaved fresh-process runs for each variant and Pi alone. It measures process-to-RPC-ready time, not TUI rendering or import time alone. `PI_COMMAND` can select the Pi executable. Startup Doctor hints run after session readiness and are cancelled when their session ends.

## Install the current development runtime

The development checkout uses pnpm workspaces and includes test dependencies, so it is not the source for `pi install git`. The Git preview workflow builds an npm-compatible runtime tree from every pushed branch except `main` and `preview`, then publishes the latest successful build to the `preview` branch in the same repository. The preview tree has no development dependencies or `workspace:` ranges. If multiple branches are active at once, the most recent successful push wins.

Install it on a work machine with Pi and Node.js:

```bash
pi install git:github.com/alexshpunt/pi-agent-ide-dev@preview
```

For the private development repository, the SSH form is also supported:

```bash
pi install git:git@github.com:alexshpunt/pi-agent-ide-dev@preview
```

After the preview workflow publishes a newer snapshot, refresh the installed package:

```bash
pi install git:github.com/alexshpunt/pi-agent-ide-dev@preview
```

To build the runtime tree locally for inspection, run `pnpm package:git-preview`. The generated files are written to `.agents/tmp/git-preview/` and are not committed to the development branch.

## Evaluate agent behavior

Unit and integration tests enforce behavior contracts. They do not show whether a tool helps an agent complete a task with fewer tokens or fewer mistakes.

The evaluator compares Pi Agent IDE and vanilla Pi under controlled profiles. The [evaluation guide](./evaluation.md) explains the measurements and their limits.

## Repository layout

```text
packages/            shared Resource, text, image, PDF, and interception libraries
src/extensions/      read, search, and text-editor cores and plugins
src/plugins/         AST, LSP, formatter, lint, and Git-aware IDE plugins
src/composite/       unified built-in registry and configuration loader
tests/integration/   umbrella real-Pi behavior tests
```

## Dependency rules

Packages inside this monorepo use `workspace:^`. pnpm links them to local source and release packaging converts the ranges.

Packages from other repositories use normal semver ranges. Local development mappings belong in `pnpm-workspace.yaml`, not in published manifests.

Do not commit machine-specific checkout paths or `file:` dependencies.

## Adding a built-in

A new built-in normally needs:

1. an independent extension entrypoint;
2. a public protocol contribution instead of a direct core dependency;
3. an entry in `src/composite/builtin-extensions.ts` with a stable ID and dependencies;
4. an entry in the modular manifest in the required load order;
5. its ID in [configuration](./configuration.md);
6. behavior coverage at the narrowest useful level.

If a feature can live as an external extension, it does not need to become a bundled built-in.
