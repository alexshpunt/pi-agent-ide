import { expect, test } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { assertJsonData, structuredResultSchema, withStructuredResult } from "./tool-result.js";

const schema = Type.Object({ count: Type.Integer() }, { additionalProperties: false });
const result = {
  content: [{ type: "text" as const, text: "Readable result" }],
  details: { private: true },
};

test("native outcomes agree with isError and leave renderer details separate", () => {
  for (const status of ["success", "error", "partial"] as const) {
    const outcome = {
      status,
      data: { count: 1 },
      errors: status === "success" ? [] : [{ code: "FAILED", message: "failed after one item" }],
    };
    const native = withStructuredResult(result, schema, outcome);
    expect(native.structuredContent).toEqual(outcome);
    expect(native.isError).toBe(status !== "success");
    expect(native.details).toBe(result.details);
    expect(native.content).toBe(result.content);
    expect(Value.Check(structuredResultSchema(schema), native.structuredContent)).toBe(true);
  }
});

test("invalid adapter data cannot become successful or leak raw details", () => {
  const native = withStructuredResult(result, schema, {
    status: "success",
    data: { count: 1, private: true },
    errors: [],
  });
  expect(native.isError).toBe(true);
  expect(native.structuredContent).toMatchObject({
    status: "error",
    errors: [{ code: "INVALID_STRUCTURED_RESULT" }],
  });
  expect(native.structuredContent).not.toHaveProperty("data");
  expect(Value.Check(structuredResultSchema(schema), native.structuredContent)).toBe(true);
});

test.each([
  new Uint8Array([1]),
  new Date(),
  { value: undefined },
  { value: NaN },
  { value: Infinity },
])("rejects lossy JSON adapter values %#", (value) => {
  expect(() => assertJsonData(value)).toThrow(TypeError);
});

test("rejects cycles and oversized public data instead of silently clipping them", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  expect(() => assertJsonData(cycle)).toThrow(TypeError);
  expect(() => assertJsonData("x".repeat(1024 * 1024))).toThrow(RangeError);
});
