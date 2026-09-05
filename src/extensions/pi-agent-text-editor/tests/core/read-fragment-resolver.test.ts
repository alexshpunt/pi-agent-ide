import { requiredValue } from "pi-agent-invariant";
import type { TextAnchor } from "pi-agent-text";
import { expect, test } from "vitest";

import {
  createReadFragmentResolver,
  type ReadFragmentAnchorSource,
} from "#src/core/read-fragment-resolver.js";
import { TextAnchorResolutionError } from "#src/core/text-anchor-registry.js";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";

const CONTENT = ["alpha", "bravo", "charlie"].join("\n");

interface CoreStubOptions {
  readonly anchor?: TextAnchor;
  readonly error?: unknown;
}

/** Builds a minimal anchor source stub that only answers resolveAnchorInText. */
function coreResolving({ anchor, error }: CoreStubOptions): ReadFragmentAnchorSource {
  return {
    resolveAnchorInText: () =>
      error !== undefined ? Promise.reject(error) : Promise.resolve(requiredValue(anchor)),
  };
}
function document() {
  return { content: CONTENT };
}

test("maps a position anchor to its line number", async () => {
  const resolver = createReadFragmentResolver(
    coreResolving({ anchor: { value: "bravo", lineNumber: 2 } as TextAnchor }),
  );
  const outcome = await resolver.resolve({
    source: "x.ts",
    fragment: "bravo",
    text: document() as never,
    cwd: "/w",
  });

  expect(outcome).toEqual({ kind: "resolved", originLine: 2 });
});

test("maps a selection anchor to the first line of its first range", async () => {
  const anchor = new TextSelectionAnchor("charlie", "x.ts", [
    {
      start: { lineNumber: 3, column: 0 },
      end: { lineNumber: 4, column: 5 },
    },
  ]);

  const resolver = createReadFragmentResolver(coreResolving({ anchor }));
  const outcome = await resolver.resolve({
    source: "x.ts",
    fragment: "charlie",
    text: document() as never,
    cwd: "/w",
  });

  expect(outcome).toEqual({ kind: "resolved", originLine: 3 });
});

test("reports resolution failures with candidate lines", async () => {
  const error = new TextAnchorResolutionError('Anchor "missing" does not match');
  error.recovery = {
    kind: "candidates",
    total: 6,
    candidates: [
      { rank: 1, range: range(4) },
      { rank: 2, range: range(9) },
    ],
  };
  const resolver = createReadFragmentResolver(coreResolving({ error }));
  const outcome = await resolver.resolve({
    source: "x.ts",
    fragment: "missing",
    text: document() as never,
    cwd: "/w",
  });

  expect(outcome).toEqual({
    kind: "failed",
    message:
      'Anchor "missing" does not match\nCandidate: line 4\nCandidate: line 9\n(+4 more candidates)',
  });
});

test("passes through plain error messages", async () => {
  const resolver = createReadFragmentResolver(
    coreResolving({ error: new Error("Anchor cannot resolve in an empty file") }),
  );
  const outcome = await resolver.resolve({
    source: "x.ts",
    fragment: "alpha",
    text: { content: "" } as never,
    cwd: "/w",
  });

  expect(outcome).toEqual({ kind: "failed", message: "Anchor cannot resolve in an empty file" });
});

function range(lineNumber: number) {
  return {
    start: { lineNumber, column: 0 },
    end: { lineNumber, column: 5 },
  };
}
