import { describe, expect, test } from "vitest";

import { createLineHashAnchor, createLineHashAnchorResolver } from "#src/anchor.js";

const resolver = createLineHashAnchorResolver();
const context = {
    source: "notes.md",
    content: "first\nsecond",
    lines: ["first", "second"],
    cwd: "/workspace",
};

describe("line hash text anchors", () =>
{
    test("extracts one unambiguous anchor from surrounding text", async () =>
    {
        const anchor = createLineHashAnchor(2, context.lines[1]!);
        const variants = [
            anchor.value,
            `${anchor.value}|`,
            `setup.ts:${anchor.value}|`,
            `use \`${anchor.value}|\` here`,
            `prefix ${anchor.value} suffix`,
        ];

        for (const value of variants)
        {
            const normalized = resolver.normalize?.(value) ?? value;
            expect(normalized).toBe(anchor.value);
            await expect(resolver.tryResolve(normalized, context)).resolves.toMatchObject({
                kind: "resolved",
                anchor: { value: anchor.value, lineNumber: 2 },
            });
        }
    });

    test("does not guess when extraction is missing or ambiguous", () =>
    {
        const anchor = createLineHashAnchor(2, context.lines[1]!).value;

        for (const value of ["no anchor", `x${anchor}y`, `${anchor} ${anchor}`])
        {
            expect(resolver.normalize?.(value)).toBe(value);
        }
    });

    test("rejects stale and out-of-range anchors", async () =>
    {
        const stale = await resolver.tryResolve("2#ZZZZ", context);
        expect(stale).toMatchObject({
            kind: "rejected",
            rejection: { code: "stale", reason: "line hash anchor is stale" },
        });

        const outOfRange = await resolver.tryResolve("3#FFFF", context);
        expect(outOfRange).toMatchObject({
            kind: "rejected",
            rejection: { code: "missing", reason: "line hash anchor is out of range" },
        });
    });

    test("ignores values outside the line hash format", async () =>
    {
        await expect(resolver.tryResolve("second", context)).resolves.toEqual({ kind: "not-handled" });
        await expect(resolver.tryResolve("2#abcd", context)).resolves.toEqual({ kind: "not-handled" });
    });
});
