import { describe, expect, test } from "vitest";

import { nullableValueSchema, scriptValueOf } from "./index.ts";

const input = (shown: string, details: unknown = {}) => ({
  shown,
  outcome: { status: "success", data: {} },
  content: [],
  details,
});

describe("scriptValueOf", () => {
  test("an IDE tool without its own value resolves to its readable string", () => {
    expect(scriptValueOf("stage").project(input("staged"))).toBe("staged");
    expect(nullableValueSchema(scriptValueOf("stage"))).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  test("a declared union gains null as one more variant", () => {
    const variants = nullableValueSchema(scriptValueOf("read")).anyOf;
    expect(Array.isArray(variants) && variants.at(-1)).toEqual({ type: "null" });
    expect(Array.isArray(variants) && variants[0]).toMatchObject({ required: ["text", "id"] });
  });

  test("an edit resolves to a provider's value when its semantic action returns one", () => {
    const details = { metadata: { semanticAction: { script: { clicked: true } } } };
    expect(scriptValueOf("write").project(input("written", details))).toEqual({ clicked: true });
    expect(scriptValueOf("delete").project(input("deleted", details))).toEqual({ clicked: true });
  });

  const uuid = "0b6a4d43-3d5e-4f0e-9c55-7a4f1c1b7e21";
  const shown = `<system-result note="Internal reference; not part of the file. Do not edit."><uuid>${uuid}</uuid></system-result>\nReplaced selected text.`;
  const edit = (data: unknown, status = "success") => ({
    shown,
    outcome: { status, data, errors: [] },
    content: [],
    details: {},
  });

  test.each(["replace", "insert", "write", "copy", "move", "undo"])(
    "%s resolves to the id of its result when it selects the new text",
    (tool) => {
      const target = "RESULT#1f2e3d4c-0000-4000-8000-000000000000";
      expect(scriptValueOf(tool).project(edit({ effect: "applied", target }))).toBe(
        `RESULT#${uuid}`,
      );
      // A pending batch acceptance names its reserved target; the next call commits the batch.
      expect(scriptValueOf(tool).project(edit({ effect: "pending", target }))).toBe(
        `RESULT#${uuid}`,
      );
      // An edit whose targets already had the text writes nothing and still selects it.
      expect(scriptValueOf(tool).project(edit({ effect: "not-applied", target }))).toBe(
        `RESULT#${uuid}`,
      );
    },
  );

  test("an edit that selects no text resolves to null", () => {
    // A directory or binary copy, an image Write or an edit whose selection could not be verified.
    expect(scriptValueOf("copy").project(edit({ effect: "applied" }))).toBeNull();
    expect(
      scriptValueOf("write").project(edit({ effect: "applied", targetUnavailable: "binary" })),
    ).toBeNull();
    // Delete leaves no text, even when its record names a target.
    const target = "RESULT#1f2e3d4c-0000-4000-8000-000000000000";
    expect(scriptValueOf("delete").project(edit({ effect: "applied", target }))).toBeNull();
    expect(scriptValueOf("replace").project(edit({ target }, "error"))).toBeNull();
  });

  test("edit declarations stay one inline union with a single null", () => {
    const replace = nullableValueSchema(scriptValueOf("replace")).anyOf;
    expect(
      Array.isArray(replace) && replace.map((variant: { type?: string }) => variant.type),
    ).toEqual(["string", "object", "null"]);
    const remove = nullableValueSchema(scriptValueOf("delete")).anyOf;
    expect(
      Array.isArray(remove) && remove.map((variant: { type?: string }) => variant.type),
    ).toEqual(["object", "null"]);
  });

  test("a failed call keeps only a provider's receipt; other failures have no value", () => {
    const details = { metadata: { semanticAction: { script: { ok: false, effect: "unknown" } } } };
    expect(scriptValueOf("insert").failed?.(input("failed", details))).toEqual({
      ok: false,
      effect: "unknown",
    });
    expect(scriptValueOf("insert").failed?.(input("failed"))).toBeUndefined();
    expect(scriptValueOf("read").failed?.({ ...input("failed"), script: true })).toBeUndefined();
  });
});
