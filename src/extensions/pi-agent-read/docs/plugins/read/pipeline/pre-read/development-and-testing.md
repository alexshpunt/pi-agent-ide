# Read plugin development and testing

## Purpose

A read plugin must prove its public behavior through the same Pi registration and invocation boundaries used at runtime. Tests load the real read core and the plugin as independent extensions.

## Black-box integration

Black-box integration is the default for resolver and pipeline plugins. A test invokes `read` through a scripted assistant tool call instead of calling a resolver or handler directly.

The test stand owns:

- a real Pi instance;
- the real read core extension;
- the real plugin entrypoint under test;
- a scripted agent provider;
- isolated invocation context and temporary external state;
- cleanup for every fixture it creates.

The stand may provide controlled inputs and observability. It must not replace the resolver, handler, registration handshake, or tool execution with test-owned implementations.

## Observable contract

A plugin test verifies the behavior relevant to its contract, including when applicable:

- extension registration and awaited setup;
- tool arguments and returned agent-native content;
- resolver or handler execution order;
- prompt contributions;
- source side effects;
- failures and cancellation;
- metadata and line projection;
- terminal pipeline outcomes.

Raw tool payloads and provider messages are valid evidence. TUI colors, layout, labels, collapsed state, and other presentation details are outside the contract unless the plugin explicitly owns them.

## Isolation

Each scenario uses a fresh Pi lifecycle or an equivalent isolated instance. Tests must:

- create temporary real fixtures when external I/O is part of the contract;
- remove every fixture they create;
- avoid process-global registries and shared mutable state;
- avoid depending on execution order;
- load only the core, the plugin under test, and required test wiring;
- test multi-plugin composition only when composition is itself the contract.

## Extension ordering

Registration tests cover both extension load orders:

1. core first, then plugin;
2. plugin first, then core.

Both orders must complete without startup races or sequential-loader deadlocks. Plugins reach core through the public readiness and registration events, never through a test-side registry call.

## Suggested organization

```text
index.ts
src/
  resolver.ts
  handler.ts

tests/
  integration/
    plugin.integration.test.ts
```

Only files required by the plugin need to exist. A resolver-only plugin does not need a handler module, and a handler-only plugin does not need a resolver module.

## Focused workflow

1. Identify one observable plugin behavior and the failure it prevents.
2. Write the smallest black-box integration scenario for that behavior.
3. Confirm the scenario reaches the real `read` tool and plugin entrypoint.
4. Implement the smallest behavior required by the contract.
5. Run the focused plugin suite.
6. Run another suite only when the change crosses that boundary.

Unit tests are useful for isolated algorithms such as deterministic classification or transformation. They do not replace integration coverage for registration, resolver selection, pipeline execution, prompt contribution, or external I/O.

## Completion standard

A plugin is ready when:

- its public behavior has a black-box integration contract;
- the test reaches a real Pi instance through public registration;
- assertions cover the relevant tool result, metadata, prompt, ordering, failure, or side effect;
- temporary state is isolated and cleaned up;
- focused type, lint, and integration checks pass.
