# Content conversion

## Purpose

The content conversion module in `pi-agent-resource` defines how source bytes become agent-native content without coupling source access to a concrete format.

A source provider owns I/O and one local converter host for each capability it exposes. A converter owner handles detection, conversion, and the agent-facing description for one content type. An adapter extension connects that converter to an exact provider target.

## Boundary

This module owns:

- the converter, input, target, outcome, and description contracts;
- runtime validation for those contracts;
- deterministic converter ordering and execution;
- target-local description snapshots in converter order;
- target-aware extension registration that works in either load order;
- rendering child content descriptions below a provider summary.

This module does not:

- read files or fetch URLs;
- contain concrete text, HTML, image, or document conversion;
- keep a process-global converter registry;
- decide which converters a user enables for a provider;
- grant source access or activate an agent capability.

## Runtime model

Providers request a host for an exact `{ provider, capability }` target. Requests on the same Pi event bus share that target's host and installed converters, including providers loaded after converter registration. Different targets and event buses stay separate. Host lookup uses the event bus, not the identity of an extension's event wrapper. Conversion calls run directly against the host.

Each provider retains ownership until its `session_shutdown`. The host removes its lookup and registration subscriptions when its last owner shuts down. Adapter subscriptions also end on shutdown, including adapters still waiting for a target. Reload and session replacement therefore build a fresh graph.

Lower priority runs first. Equal priorities keep registration order. One conversion snapshots the current list and invokes converters one at a time. `converted` and `failed` are terminal, invalid outcomes are terminal, cancellation is terminal, and exhausting the list throws an unsupported-content error.

A converter ID is unique within one target. The same converter may be installed in another target.

## Description metadata

Every converter has one required, provider-neutral, single-line description. `ContentHost.listDescriptions()` returns fresh `{ id, description }` values for that exact target in conversion order.

A provider can render this snapshot below its own summary. An empty snapshot produces no provider description. The metadata tells the agent what the loaded graph can handle. It does not grant permission, register a converter, choose a converter, or change conversion behavior.

## Direction

A converter used by one adapter stays with that adapter. Extract a provider-neutral type package when more than one provider uses the converter. Adding a format must not require source providers or capability cores to learn its parsing rules.
