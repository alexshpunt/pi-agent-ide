import { expect, test } from "vitest";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { composeCapabilitySchema } from "./capability-schemas.js";

const first = "fixture-first";
const second = "fixture-second";
const parameters = Type.Object({
  path: Type.String({ minLength: 1, description: "Fixture path" }),
});
const definition: ToolDefinition<typeof parameters> = {
  name: "read",
  label: "read",
  description: "Read fixture",
  parameters,
  promptGuidelines: ["Fixture rule"],
  async execute(_id, input) {
    return { content: [{ type: "text", text: input.path }], details: undefined };
  },
};

test("inactive contributions leave a tool unchanged", () => {
  expect(composeCapabilitySchema(definition, [])).toBe(definition);
});

test("independent contributions compose without changing validation or execution", async () => {
  const initial = JSON.stringify(definition.parameters);
  const composed = composeCapabilitySchema(definition, [
    { description: first, parameters: { path: first }, promptGuidelines: [first] },
    { description: second, parameters: { path: second }, promptGuidelines: [second, first] },
    { description: first, parameters: { path: first } },
  ]);
  expect(composed.description).toContain(first);
  expect(composed.description).toContain(second);
  expect(composed.description.split(first)).toHaveLength(2);
  const { description } = composed.parameters.properties.path as { description?: string };
  expect(description).toContain(first);
  expect(description).toContain(second);
  expect(composed.parameters.properties.path).toMatchObject({ minLength: 1 });
  expect(composed.parameters.required).toEqual(["path"]);
  expect(composed.promptGuidelines?.filter((item) => item === first)).toHaveLength(1);
  expect(composed.execute).toBe(definition.execute);
  expect(
    await composed.execute("call", { path: first }, undefined, undefined, {} as never),
  ).toMatchObject({ content: [{ text: first }] });
  expect(JSON.stringify(definition.parameters)).toBe(initial);
});

test("deferred rules are included in inline tool declarations for the next request", () => {
  const composed = composeCapabilitySchema(definition, [{ promptGuidelines: [first] }]);
  expect(composed.description).toContain(first);
  expect(composed.promptGuidelines).toContain(first);
});

test("unknown parameter contributions fail before publishing a broken declaration", () => {
  expect(() => composeCapabilitySchema(definition, [{ parameters: { absent: first } }])).toThrow(
    Error,
  );
});

test("fresh base metadata is used when a core republishes its tool", () => {
  const contributions = [{ parameters: { path: first } }];
  const before = composeCapabilitySchema(definition, contributions);
  const base = { ...definition, parameters: Type.Object({ path: Type.String({ maxLength: 64 }) }) };
  const after = composeCapabilitySchema(base, contributions);
  expect(after.parameters.properties.path).toMatchObject({ maxLength: 64 });
  expect(after.parameters.properties.path).toMatchObject({ description: first });
  expect(before.parameters.properties.path).toMatchObject({ minLength: 1 });
});
