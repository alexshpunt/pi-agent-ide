import { expect, test } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { assertJsonData, structuredResultSchema, withStructuredResult } from "./tool-result.js";

const schema = Type.Object({ count: Type.Integer() }, { additionalProperties: false });
const result = {
  content: [{ type: "text" as const, text: "Readable result" }],
  details: { private: true },
};

test("exposes the common object fields without removing the outcome alternatives", () => {
  expect(structuredResultSchema(schema)).toMatchObject({
    type: "object",
    properties: {
      status: { anyOf: [{ const: "success" }, { const: "error" }, { const: "partial" }] },
      data: schema,
      errors: { type: "array" },
    },
    required: ["status", "errors"],
    additionalProperties: false,
    anyOf: [{ required: ["status", "data", "errors"] }, { required: ["status", "errors"] }],
  });
});

test.each([
  { status: "success", data: { count: 1 }, errors: [] },
  { status: "error", errors: [{ code: "FAILED", message: "failed" }] },
  { status: "partial", data: { count: 1 }, errors: [{ code: "FAILED", message: "failed" }] },
])("accepts valid public outcomes %#", (outcome) => {
  expect(Value.Check(structuredResultSchema(schema), outcome)).toBe(true);
});

test.each([
  { status: "success", errors: [] },
  { status: "success", data: { count: 1 }, errors: [{ code: "FAILED", message: "failed" }] },
  { status: "error", errors: [] },
  { status: "partial", data: { count: 1 }, errors: [] },
  { status: "error", errors: [{ code: "FAILED" }] },
  { status: "error", data: { count: "wrong" }, errors: [{ code: "FAILED", message: "failed" }] },
  { status: "success", data: { count: 1, extra: true }, errors: [] },
  { status: "success", data: { count: 1 }, errors: [], extra: true },
  { data: { count: 1 }, errors: [] },
  { status: "unknown", errors: [{ code: "FAILED", message: "failed" }] },
])("rejects invalid public outcomes %#", (outcome) => {
  expect(Value.Check(structuredResultSchema(schema), outcome)).toBe(false);
});

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
