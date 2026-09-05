import { TextAnchor, type TextAnchorResolver } from "pi-agent-text";
import { expect, test } from "vitest";

import { TextAnchorRegistry, TextAnchorResolutionError } from "#src/core/text-anchor-registry.js";

const POSITION_KIND = "fixture/position";
const OPERATION_KIND = "fixture/operation";

class FixtureTextAnchor extends TextAnchor {
  public constructor(lineNumber: number) {
    super("anchor", lineNumber);
  }
}

test("resolves through a stable priority-ordered anchor chain", async () => {
  const calls: string[] = [];
  const registry = new TextAnchorRegistry();

  registry.add({
    resolver: resolver("later", 2, calls),
    kind: POSITION_KIND,
    type: "constant",
    priority: 10,
  });
  registry.add({
    resolver: resolver("first", undefined, calls),
    kind: POSITION_KIND,
    type: "auxiliary",
    priority: -1,
  });

  await expect(
    registry.snapshot().resolve("anchor", {
      source: "notes.md",
      content: "first\nsecond",
      lines: ["first", "second"],
      cwd: "/workspace",
    }),
  ).resolves.toMatchObject({ value: "anchor", lineNumber: 2 });
  expect(calls).toEqual(["first", "later"]);
});

test("normalizes presented anchors before resolution", async () => {
  const registry = new TextAnchorRegistry();
  const normalized = {
    ...resolver("normalized", 2),
    normalize: (value: string) => (value.endsWith("|") ? value.slice(0, -1) : value),
  };
  registry.add({ resolver: normalized, kind: POSITION_KIND, type: "major" });

  await expect(
    registry.snapshot().resolve("anchor|", {
      source: "notes.md",
      content: "first\nsecond",
      lines: ["first", "second"],
      cwd: "/workspace",
    }),
  ).resolves.toMatchObject({ value: "anchor", lineNumber: 2 });
});

test("filters resolution and inspection by dynamic anchor kind", async () => {
  const registry = new TextAnchorRegistry();
  const inspected: string[] = [];
  const context = {
    source: "notes.md",
    content: "first\nsecond",
    lines: ["first", "second"],
    cwd: "/workspace",
  };

  registry.add({
    resolver: resolver("position", 1, inspected),
    kind: POSITION_KIND,
    type: "constant",
  });
  registry.add({
    resolver: resolver("operation", 2, inspected),
    kind: OPERATION_KIND,
    type: "auxiliary",
  });

  await expect(
    registry.snapshot().resolve("anchor", context, new Set([OPERATION_KIND])),
  ).resolves.toMatchObject({ lineNumber: 2 });
  await expect(
    registry.snapshot().inspect(["anchor"], [[OPERATION_KIND]], context),
  ).resolves.toEqual({ kind: "valid" });
  expect(inspected).toEqual(["operation", "operation"]);
  await expect(
    registry.snapshot().resolve("anchor", context, new Set(["unknown/kind"])),
  ).rejects.toThrow(/No text anchor resolver/u);
});

test("rejects duplicate resolver IDs, a second major, and missing lines", async () => {
  const registry = new TextAnchorRegistry();
  registry.add({ resolver: resolver("major", 1), kind: POSITION_KIND, type: "major" });

  expect(() =>
    registry.add({ resolver: resolver("major", 1), kind: POSITION_KIND, type: "constant" }),
  ).toThrow(/already registered/u);
  expect(() =>
    registry.add({ resolver: resolver("other-major", 1), kind: POSITION_KIND, type: "major" }),
  ).toThrow(/major/u);
  await expect(
    registry.snapshot().resolve("anchor", {
      source: "empty.md",
      content: "",
      lines: [],
      cwd: "/workspace",
    }),
  ).rejects.toThrow(/empty file/u);
});

test("rejects recovery candidates outside the current snapshot", async () => {
  const registry = new TextAnchorRegistry();
  registry.add({
    kind: POSITION_KIND,
    type: "auxiliary",
    resolver: {
      id: "invalid-recovery",
      description: "Invalid recovery fixture.",
      renderFull(value) {
        return value;
      },
      renderCompact(value) {
        return value;
      },
      tryResolve: () =>
        Promise.resolve({
          kind: "rejected",
          rejection: { code: "missing", reason: "missing" },
        }),
      recover: () =>
        Promise.resolve({
          kind: "candidates",
          total: 1,
          candidates: [
            {
              rank: 1,
              range: {
                start: { lineNumber: 99, column: 0 },
                end: { lineNumber: 99, column: 1 },
              },
            },
          ],
        }),
    },
  });

  try {
    await registry.snapshot().resolve("missing", {
      source: "notes.md",
      content: "one line",
      lines: ["one line"],
      cwd: "/workspace",
    });
    throw new Error("Expected anchor resolution to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(TextAnchorResolutionError);
    if (!(error instanceof TextAnchorResolutionError)) {
      throw error;
    }
    expect(error.recovery).toBeUndefined();
    await error.refreshRecovery();
    expect(error.recovery).toMatchObject({ kind: "failed" });
  }
});

function resolver(
  id: string,
  lineNumber: number | undefined,
  calls: string[] = [],
  description: TextAnchorResolver["description"] = id,
): TextAnchorResolver {
  return {
    id,
    description,
    renderFull(value) {
      return value;
    },
    renderCompact(value) {
      return value;
    },
    tryResolve() {
      calls.push(id);
      return Promise.resolve(
        lineNumber === undefined
          ? { kind: "not-handled" }
          : { kind: "resolved", anchor: new FixtureTextAnchor(lineNumber) },
      );
    },
  };
}
