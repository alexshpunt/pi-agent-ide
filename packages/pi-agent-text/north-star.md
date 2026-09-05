# `pi-agent-text`

## Purpose

`pi-agent-text` owns source-neutral text contracts.

It provides strict UTF-8 conversion, text documents and presentation, line anchors, and typed text targets. It performs no source I/O and does not own a resolver registry.

## Text conversion

The package recognizes textual media types, decodes strict UTF-8 bytes, and validates the one-text-block shape used by source writes.

## Text anchors

A text anchor resolver receives:

- an opaque anchor string;
- the resolved source identity;
- the exact current text content and its lines;
- cwd;
- an optional cancellation signal.

It asynchronously returns `not-handled`, `resolved` with a `TextAnchor`, `rejected` with recovery context, or `failed` with an error. `TextAnchor` is an abstract resolved value with the opaque input value and one concrete line number. Resolver extensions create concrete anchor subclasses; consumers cannot replace them with arbitrary strings.

The protocol contains no tool ID, parameter role, mutation placement, range, or presentation behavior. The package exports runtime guards for resolvers and their results. Consuming cores own resolver order, failure mapping, and recovery presentation.

## Typed text targets

A `TextTargetResolver` resolves one opaque value before a Resource is read. It returns `not-handled`, `resolved`, `rejected`, or `failed`. A resolved result contains one or more `TextTarget` values:

```ts
interface TextSelectionPosition {
  readonly lineNumber: number; // one-based
  readonly column: number; // zero-based
}

interface TextSelectionRange {
  readonly start: TextSelectionPosition;
  readonly end: TextSelectionPosition;
  readonly linewise?: boolean;
}

interface TextTarget {
  readonly source: string;
  readonly ranges?: readonly TextSelectionRange[];
}

interface TextTargetResolverContext {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

type TextTargetResolutionAttempt =
  | { readonly kind: "not-handled" }
  | { readonly kind: "resolved"; readonly targets: readonly TextTarget[] }
  | {
      readonly kind: "rejected";
      readonly rejection: {
        readonly code: "invalid" | "stale" | "missing" | "ambiguous";
        readonly reason: string;
        readonly contextRange?: { readonly offset: number; readonly limit: number };
      };
    }
  | { readonly kind: "failed"; readonly error: unknown };

interface TextTargetResolver {
  readonly id: string;
  tryResolve(
    value: string,
    context: TextTargetResolverContext,
  ): TextTargetResolutionAttempt | Promise<TextTargetResolutionAttempt>;
}
```

Ranges are half-open character ranges. When `ranges` is omitted, read synthesizes a first-line chunk, while the editor treats the source as the target scope. `linewise` tells mutation operations that a range represents complete lines, including final-line behavior when the file has no trailing line ending. It does not change the range coordinates.

A resolved attempt must contain at least one target. `isTextTargetResolutionAttempt()` validates untrusted resolver output. Consuming cores then validate range order and bounds against each current Resource snapshot.

The package root exports `TextSelectionPosition`, `TextSelectionRange`, `TextTarget`, `TextTargetResolutionAttempt`, `TextTargetResolver`, `TextTargetResolverContext`, and `isTextTargetResolutionAttempt`. Read and editor plugins register these resolvers through their own versioned protocols.

The resolver owns the opaque syntax. A search resolver may turn `SEARCH#...` values into current Resource sources and exact ranges, but read and editor consumers must not parse that string themselves. They validate and use the typed result.

## Invariants

1. A resolved line anchor names one concrete existing line.
2. A resolved text target contains at least one non-empty source identity.
3. Target ranges use one-based lines, zero-based columns, and half-open endpoints.
4. Resolver implementations own anchor and target syntax.
5. Mutation semantics belong to editor operations.
6. Presentation is independent from resolution.
7. Consuming cores own registries and failure mapping.
8. The package performs no source I/O. Its text contracts use no Pi APIs; content conversion follows the shared `pi-agent-resource` contract.
