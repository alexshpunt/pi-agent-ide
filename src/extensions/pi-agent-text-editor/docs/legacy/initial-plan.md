# North Star: `pi-agent-text-editor`

## Context

We are planning a new, initially standalone Pi package/extension named `pi-agent-text-editor`. Its text tools should preserve the hash-anchor-based editing model of `pi-agentic-ide`, while removing UI, undo, event-bus, and other incidental side effects from the core tool implementation. The package must support independently installed plugins under `pi-agent-text-editor/plugins/`, registered through `pi.events`, with the core owning an awaitable mutation/read pipeline.

This document is intentionally a north-star architecture and migration plan, not an immediate integration into Pi. The first proof point is an isolated integration-test harness modeled on `pi-agentic-ide/integration-tests`.

## Approach

- Define a small protocol-only API package containing event/channel names, API version, and handler/state types; do not put a singleton registry in it.
- Implement a core registry and handshake over `pi.events`: listen for `plugin/register`, validate API version and unique IDs, register stage handlers, and publish `core/ready`. Plugins register eagerly and also retry/register on readiness.
- Keep execution in core: each text read/edit tool awaits every handler in stage order and passes the state returned by one stage to the next. `pi.events` is transport/handshake only, never the execution mechanism.
- Distill the existing `tool-text-*` surface into anchor-based core tools, then migrate guards and reliability behavior—stale anchors, batching, recovery, and inherited paths—without coupling those mechanisms to the old extension's rendering/undo/event infrastructure.
- Move existing LSP, AST, and formatter behavior into separate plugins incrementally. Do not load the new package in the production Pi extension until the standalone integration suite proves parity and pipeline behavior.

## Confirmed decisions

- Canonical stage names are `text-pre-edit`, `text-edit`, `text-post-edit`, `text-pre-read`, `text-read`, and `text-post-read`.
- Handler execution is asynchronous and awaitable: a handler receives the current stage state and returns `Promise<State>`; the returned state is passed unchanged to the next handler.
- Handler failure is fail-fast: core stops the current pipeline, does not invoke later handlers, and returns a structured tool error with plugin/stage context.
- The north-star artifact belongs with the future `pi-agent-text-editor` package; this `PLAN.md` is the reviewable working plan until that package root exists.
- The first protocol allows at most one handler per plugin per stage; handlers from different plugins run in registration order. Plugin disposal/unregistration is deferred until lifecycle requirements appear.

## North-star invariants

1. **Core owns execution.** `pi.events` carries registration and readiness messages only; it is never used to run the pipeline or to obtain a handler's return value.
2. **Core owns the registry.** It validates `apiVersion`, rejects duplicate `pluginId`s, records handlers, and defines deterministic registration order (registration order unless a later protocol decision adds explicit priority).
3. **State is the product.** Each stage receives the complete operation-specific state produced by the previous stage. Core does not merge, clone, or reinterpret plugin output between handlers.
4. **Filesystem mutation is intentional; incidental effects are not.** Core tools may read/write files and return structured results, but must not depend on TUI rendering, undo tracking, annotations, Pi message renderers, or a process-global registry shared through the API package.
5. **Read and edit are symmetric pipelines.** A read pipeline can transform request, raw/read result, and final read result; an edit pipeline can transform normalized request, mutation result, and final edit result.
6. **Reliability behavior remains observable and testable.** Stale-anchor blocking, batching, recovery, and inherited paths are core contracts with structured outcomes, not hidden Pi-specific interceptors.

## Protocol shape to specify

- Stateless shared API: protocol version, channel constants, stage names, registration payload, readiness payload, operation-specific state types, and handler types.
- Registration handshake: core subscribes to `plugin/register` before announcing `core/ready`; every plugin sends an eager registration and listens for `core/ready` so either load order works.
- Registry rules: validate supported API version, require a unique stable `pluginId`, retain only declared handlers, and expose diagnostics for rejected registrations.
- Pipeline rules: snapshot the registered handler list for one invocation, await handlers sequentially per stage, pass each returned state forward, fail fast on rejection/throw, and return the final state through the tool.
- Handler cardinality/lifecycle: at most one handler per plugin per stage in protocol v1; different plugins execute in registration order; disposal/unregistration is deferred until a lifecycle requirement appears.

### Stage boundary

`text-pre-*` handlers transform the normalized request/state; core then performs the anchor-based read/edit operation; `text-*` handlers transform the operation result; `text-post-*` handlers transform the final result before the tool returns. This keeps the actual filesystem operation in core. State types are operation-specific (`ReadState`/`EditState`) and carry invocation context, normalized entries, intermediate results, and structured errors without forcing a JSON serialization boundary.

## Planned package boundaries

- `pi-agent-text-editor/core/`: stateless anchor/file primitives, normalized read/edit states, tool implementations, registry, handshake, pipeline runner, and structured reliability errors.
- `pi-agent-text-editor/api/` (or a separately published protocol package): types, constants, and version only; no registry singleton and no runtime coupling to one module root.
- `pi-agent-text-editor/plugins/`: independently loadable LSP, AST, formatter, and later guard/recovery plugins, each declaring a Pi extension in its own package manifest as appropriate.
- `pi-agent-text-editor/integration-tests/`: isolated Pi extension registration adapter, harness, baseline parity tests, handshake tests, pipeline mutation tests, and reliability matrix. Production Pi configuration is out of scope for the first milestone.

## Files to modify

- `PLAN.md` — this reviewed north-star plan.
- `pi-agent-text-editor/` — new standalone package root; implementation will follow the boundaries and migration phases below.
- Existing reference implementation (read-only during this planning task):
  - `legacy-reference/pi-agentic-ide/src/tools/tool-text-*.ts`
  - `legacy-reference/pi-agentic-ide/src/tools/text-edit-interceptors.ts`
  - `legacy-reference/pi-agentic-ide/src/tools/text-edit-recovery.ts`
  - `legacy-reference/pi-agentic-ide/src/tools/path-inheritance.ts`
  - `legacy-reference/pi-agentic-ide/integration-tests/`

## Reuse

- Existing anchor validation, read/edit entry semantics, and `FileAnchor`/`TextEditEngine` behavior from `pi-agentic-ide` and its `agentic-ide/text-editor` dependency.
- Existing `tool-text-insert`, `replace`, `delete`, `write`, `copy`, `move`, and `batch` parameter mapping as the compatibility baseline.
- Existing stale-anchor descriptors and path inheritance as behavioral references; recovery and batching become core pipeline concerns rather than Pi UI adapters.
- Existing integration-test fixtures and per-tool test structure as the test-harness model.
- Pi's `pi.events` only for registration and readiness handshake; the shared API package remains stateless.
- Pi package conventions: `package.json` `pi.extensions`/conventional `src/extensions/` discovery, npm/git installation, and separate module roots confirm why the API package must remain stateless.

## Migration phases

1. **Protocol and harness first.** Create the stateless API contract, a fake/in-memory event bus for tests, the core registry/handshake, and a test-only extension that registers the new tools without touching production Pi configuration.
2. **Anchor-tool baseline.** Port the seven `tool-text-*` operations (`write`, `insert`, `replace`, `delete`, `copy`, `move`, `batch`) plus read support with only filesystem/anchor behavior and structured results. Keep schemas and anchor semantics compatible with the reference.
3. **Reliability parity.** Port stale-anchor checks, batch coordination/atomicity, structured recovery, and path inheritance. Add tests for single calls, same-message batches, cross-file source/target inheritance, stale anchors, overwrite/recovery, and partial failures.
4. **Pipeline proof.** Add deterministic plugins that record order and mutate pre/edit/post states for both reads and edits; test eager registration, `core/ready` race, duplicate/version rejection, sequential awaiting, fail-fast behavior, and final-state propagation.
5. **Plugin extraction.** Move the existing LSP, AST, and formatter implementations one at a time into `plugins/`, preserving behavior through parity tests. Treat guards as core reliability behavior unless a later design explicitly proves they are plugin policy.
6. **Production integration gate.** Only after the standalone suite is green and parity is demonstrated should a separate plan introduce the package into Pi; this plan does not perform that integration.

## Steps

- [ ] Confirm the canonical event names, protocol state contracts, package layout, and scope of the north-star document.
- [ ] Inventory the current `tool-text-*` public schemas, result shapes, guards, batching, recovery, and inherited-path behavior; mark what is core versus plugin behavior.
- [ ] Specify the protocol-only package: versioning, `plugin/register`, `core/ready`, stage names, handler errors, ordering, and mutation semantics.
- [ ] Specify core package boundaries: anchor engine/filesystem adapter, tool registration, plugin registry, handshake lifecycle, and sequential awaitable pipelines for edit/read.
- [ ] Define the standalone test extension/harness and integration matrix, including adversarial plugin fixtures that mutate state at every stage.
- [ ] Define incremental extraction order for the baseline tools and LSP/AST/formatter plugins, with no production Pi integration in the initial phases.
- [ ] Define parity, failure, ordering, and readiness acceptance criteria that must pass before migration into Pi.

## Verification

- Validate the document against the agreed protocol and migration boundaries.
- During implementation, run the new package's typecheck and isolated integration tests only; do not register it in the production Pi extension initially.
- Verify end-to-end that plugins can register regardless of load order, duplicate/unsupported registrations are rejected, handlers execute sequentially, each stage can mutate the next state, failures have defined behavior, and the final tool result preserves anchor/guard/batch/recovery/path-inheritance semantics.
- Compare the standalone tool behavior with the existing `pi-agentic-ide` integration suite before any production integration is proposed.
