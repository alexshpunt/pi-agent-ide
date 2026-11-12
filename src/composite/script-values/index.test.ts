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
    expect(Array.isArray(variants) && variants[0]).toEqual({ type: "string" });
  });

  test("an edit resolves to a provider's value when its semantic action returns one", () => {
    const details = { metadata: { semanticAction: { script: { clicked: true } } } };
    expect(scriptValueOf("write").project(input("written", details))).toEqual({ clicked: true });
    expect(scriptValueOf("write").project(input("written"))).toBe("written");
  });

  test("a failed call keeps only a provider's receipt; other failures have no value", () => {
    const details = { metadata: { semanticAction: { script: { ok: false, effect: "unknown" } } } };
    expect(scriptValueOf("insert").failed?.(input("failed", details))).toEqual({
      ok: false,
      effect: "unknown",
    });
    expect(scriptValueOf("insert").failed?.(input("failed"))).toBeUndefined();
    expect(scriptValueOf("read").failed).toBeUndefined();
  });

  test("an image Read resolves to its image block with the readable note", () => {
    const value = scriptValueOf("read").project({
      ...input("shown"),
      content: [
        { type: "text", text: "shown" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    });
    expect(value).toEqual({ type: "image", data: "AAAA", mimeType: "image/png", note: "shown" });
  });
});
