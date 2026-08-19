import { Type } from "typebox";
import { expect, test } from "vitest";

import { appendSchemaFieldOrder } from "#src/core/tool-description.js";

test("appends schema fields in declaration order", () =>
{
    const schema = Type.Object({
        path: Type.Optional(Type.String()),
        start: Type.String(),
        end: Type.Optional(Type.String()),
        text: Type.String(),
    });

    expect(appendSchemaFieldOrder("Replace selected lines.", schema)).toBe(
        "Replace selected lines.\nArgument order: `path`, `start`, `end`, `text`.",
    );
});
