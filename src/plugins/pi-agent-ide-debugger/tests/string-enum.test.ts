import { expect, test } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { StringEnum } from "#src/plugins/pi-agent-ide-debugger/src/string-enum.ts";

test("StringEnum serializes as a plain string enum", () => {
  expect(JSON.parse(JSON.stringify(StringEnum(["launch", "attach"])))).toEqual({
    type: "string",
    enum: ["launch", "attach"],
  });
  expect(
    JSON.parse(
      JSON.stringify(
        StringEnum(["launch", "attach"], { description: "How to start", default: "launch" }),
      ),
    ),
  ).toEqual({
    type: "string",
    enum: ["launch", "attach"],
    description: "How to start",
    default: "launch",
  });
});

test("StringEnum validates inside a TypeBox object", () => {
  const schema = Type.Object({ mode: StringEnum(["launch", "attach"]) });
  expect(Value.Check(schema, { mode: "attach" })).toBe(true);
  expect(Value.Check(schema, { mode: "other" })).toBe(false);
});
