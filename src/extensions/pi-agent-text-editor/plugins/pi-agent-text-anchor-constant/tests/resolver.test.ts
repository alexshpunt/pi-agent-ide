import { describe, expect, test } from "vitest";

import { createConstantTextAnchorResolver } from "../src/resolver.js";

const resolver = createConstantTextAnchorResolver();

describe("constant text anchors", () =>
{
    test("resolves begin and end to existing edge lines", async () =>
    {
        const context = {
            source: "notes.md",
            content: "first\nmiddle\nlast",
            lines: ["first", "middle", "last"],
            cwd: "/workspace",
        };

        await expect(resolver.tryResolve("begin", context)).resolves.toMatchObject({
            kind: "resolved",
            anchor: { value: "begin", lineNumber: 1 },
        });
        await expect(resolver.tryResolve("end", context)).resolves.toMatchObject({
            kind: "resolved",
            anchor: { value: "end", lineNumber: 3 },
        });
    });

    test("rejects edge anchors for empty text and ignores unknown values", async () =>
    {
        const emptyContext = {
            source: "empty.md",
            content: "",
            lines: [],
            cwd: "/workspace",
        };

        const failed = await resolver.tryResolve("begin", emptyContext);
        expect(failed).toMatchObject({ kind: "failed" });
        expect(failed.kind === "failed" ? failed.error : undefined).toEqual(
            new Error("begin cannot resolve in an empty file"),
        );
        await expect(resolver.tryResolve("middle", emptyContext)).resolves.toEqual({ kind: "not-handled" });
    });
});
