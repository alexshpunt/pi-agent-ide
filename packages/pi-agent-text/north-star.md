# `pi-agent-text`

## Purpose

`pi-agent-text` owns source-neutral text-domain contracts.

It provides strict UTF-8 conversion and the shared protocol for resolving opaque text anchor strings to existing lines.

## Text conversion

The package recognizes textual media types, decodes strict UTF-8 bytes, and validates the one-text-block shape used by source writes.

## Text anchors

A text anchor resolver receives:

- an opaque anchor string;
- the resolved source identity;
- the exact current text content and its lines;
- cwd;
- an optional cancellation signal.

It asynchronously returns `not-handled`, `resolved` with a `TextAnchor`, or `failed` with an error. `TextAnchor` is an abstract resolved value object with the opaque input value and one concrete line number. Resolver extensions create concrete anchor subclasses; consumers cannot replace them with arbitrary strings. The protocol contains no tool ID, parameter role, mutation placement, range, or presentation behavior.

The package exports structural runtime guards for resolvers and fulfilled attempts. It owns no resolver registry, priority policy, prompt rendering, source I/O, or Pi extension.

## Invariants

1. A resolved anchor means one concrete existing line.
2. Anchor syntax belongs to resolver implementations.
3. Mutation semantics belong to editor operations.
4. Presentation is independent from resolution.
5. Consuming cores own registries and failure mapping.
6. The package performs no source I/O. Its text contracts use no Pi APIs; content conversion follows the shared `pi-agent-resource` contract.
