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

Use a temporary config without changing your normal Pi setup:

```bash
PI_AGENT_IDE_CONFIG=./pi-agent-ide.json pi --no-extensions -e .
```

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
