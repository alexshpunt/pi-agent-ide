# Runtime validation contract

## Purpose

This document defines runtime validation for values that use `pi-agent-resource` contracts across plugin boundaries.

TypeScript types do not validate values returned by independently loaded plugins. `pi-agent-resource` therefore exports aggregate type guards. Consuming cores decide how a failed guard becomes a registration or capability error.

## Public functions

```ts
export function isAgentContent(value: unknown): value is AgentContent;

export function isResource(value: unknown): value is Resource;

export function isResourceResolver(value: unknown): value is ResourceResolver;

export function isResourceResolutionAttempt(
    value: unknown,
): value is ResourceResolutionAttempt;
```

These four functions are the complete public runtime validation API.

The package does not export assertion functions, validation schemas, validation error classes, or parsers. It does not export separate public guards for individual content blocks, contexts, or callbacks.

## Internal TypeBox implementation

The guard implementations use private TypeBox schemas and `Value.Check`.

`typebox` is a direct runtime dependency of `pi-agent-resource`. The package does not require consumers to import TypeBox and does not use the `typebox-guard` alias.

The schemas are implementation details. They are not exported and public contract types are not derived from `Static<typeof schema>`. Public types remain the definitions in this package and the direct Pi type re-exports.

The schemas express the contract rules directly:

- object schemas explicitly allow additional properties;
- non-empty strings use `minLength: 1`;
- AgentContent uses an array schema with `minItems: 1`;
- opaque required fields use `Type.Unknown()`;
- callbacks use `Type.Function([], Type.Unknown())` only to check that a value is callable;
- absent Resource capabilities use `Type.Optional(Type.Never())` inside the three Resource union branches.

TypeBox treats an optional property whose value is `undefined` as absent. The guards therefore perform an additional safe presence check for `textSignature`, `read`, and `write`, and revalidate the nested Resource in a resolved attempt. A present optional common field must still satisfy its contract.

Every exported guard calls `Value.Check` through a private safe wrapper. If TypeBox throws while inspecting an unknown value, the wrapper returns `false`. The guards do not decode, clean, convert, or replace values.

## Guard behavior

Every guard:

- accepts `unknown`;
- returns `true` only when the value satisfies the relevant common contract;
- returns `false` for a contract mismatch instead of throwing a validation error;
- treats a value whose required properties cannot be read as invalid;
- does not mutate, clone, freeze, normalize, or replace the input;
- does not invoke resolver, read, or write callbacks;
- does not depend on class identity or `instanceof`.

The guards validate common structure and invariants. They do not validate source-specific behavior.

## Structural values

In this document, an object is a non-null, non-array JavaScript object. Arrays and functions do not satisfy an object contract.

Contract values may contain additional extension-owned fields. A guard ignores fields that are not part of the common contract.

Known common fields must still have their defined shape. An additional field cannot replace a required field or change the type of a known field.

A required non-empty string passes when its JavaScript string length is greater than zero. Guards do not trim or normalize strings. Whitespace-only strings are therefore structurally non-empty.

`readonly` is a TypeScript constraint. Runtime guards do not freeze values or require them to already be frozen.

## isAgentContent

`isAgentContent` returns `true` when:

1. the value is an array;
2. the array contains at least one item;
3. every item is a valid `TextContent`, `ImageContent`, or `CustomContent` block.

A text block has:

- `type` equal to `"text"`;
- a string `text`;
- no `textSignature`, or a string `textSignature`.

An image block has:

- `type` equal to `"image"`;
- a string `data`;
- a string `mimeType`.

A custom block has:

- `type` equal to `"custom"`;
- a non-empty string `kind`;
- a present `data` field.

`CustomContent.data` is `unknown`. Any value, including `undefined`, is valid when the field is present. The guard does not inspect or serialize it.

The guard does not decode image data or resolve MIME types. Producing base64 image data and a correct MIME type remains the producer's contract.

Sparse arrays, empty arrays, unknown block discriminators, and blocks missing a required field are invalid.

## isResource

`isResource` returns `true` when:

1. the value is an object;
2. `source` is a non-empty string;
3. `read` is a function, `write` is a function, or both are functions;
4. a present `read` or `write` field is a function.

A resource with neither operation is invalid. A non-function value in either operation field is invalid.

The guard checks callback presence only. It does not call an operation, inspect its promise, or predict its result.

## isResourceResolver

`isResourceResolver` returns `true` when:

1. the value is an object;
2. `id` is a non-empty string;
3. `tryResolve` is a function.

The guard does not call `tryResolve`. It cannot establish at registration time whether the callback returns a promise or a valid `ResourceResolutionAttempt`.

Resolver ID uniqueness and stability are registry concerns. This guard checks only the current ID value.

## isResourceResolutionAttempt

`isResourceResolutionAttempt` first requires an object with one recognized `kind` discriminator.

For `kind: "not-handled"`, no other common field is required.

For `kind: "resolved"`, a `resource` field is required and must pass `isResource`.

For `kind: "failed"`, an `error` field is required. The error value is `unknown`, so any value, including `undefined`, is valid when the field is present.

The discriminator selects the outcome. Additional fields do not change that outcome.

## Required validation points

A consuming core applies the guards at every boundary where a plugin supplies one of these common values.

### Resolver registration

A core calls `isResourceResolver` before adding a resolver to its registry.

An invalid resolver is rejected and is never registered. The core owns the registration error and its diagnostics.

### Resolution result

After `tryResolve` fulfills, the core calls `isResourceResolutionAttempt` before reading the outcome.

The guard validates a nested Resource for a `resolved` outcome. A second `isResource` call is not required.

An invalid fulfilled value is a terminal plugin contract failure for the current resolution. The core does not continue to a later resolver.

A thrown or rejected `tryResolve` call is not a guard failure. It follows the terminal failure behavior defined in [`resolver.md`](./resolver.md).

### Read result

After `resource.read()` fulfills, the core calls `isAgentContent` before passing the value to a pipeline or returning it.

Invalid content is a terminal plugin contract failure. It is not an empty resource and is not converted to content automatically.

A thrown or rejected read remains a source operation failure as defined in [`resource.md`](./resource.md).

### Write input

A core calls `isAgentContent` on the final content before passing it to `resource.write()`.

If the value is invalid, the core does not call the writer. The core reports its own contract failure.

A fulfilled write result is ignored because the common result is `void`. A thrown or rejected write remains a source operation failure.

## Failure ownership

`pi-agent-resource` reports validation only as `true` or `false`.

Each consuming core owns:

- registration rejection behavior;
- capability-specific failure codes;
- user-facing messages;
- diagnostic context;
- logging and recovery.

A core may include resolver ID and source context in its own diagnostics. The shared package does not create a universal contract error.

## Invariants

1. Plugin-supplied common values are checked before use.
2. Guards validate structure without invoking callbacks.
3. A resolved outcome includes a valid Resource.
4. A successful read includes valid, non-empty AgentContent.
5. Invalid resolver output is terminal and never enables fallback.
6. Additional extension-owned fields are allowed.
7. Guard failures remain owned by the consuming core.
8. No validation path mutates the original value.
