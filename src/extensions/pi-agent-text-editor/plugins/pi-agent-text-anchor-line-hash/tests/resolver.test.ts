import { describe, expect, test } from "vitest";

import { formatLineHashAnchor, createLineHashAnchorResolver } from "#src/anchor.ts";

const resolver = createLineHashAnchorResolver();

function contextFor(content: string) {
  return { source: "notes.md", content, lines: content.split("\n"), cwd: "/workspace" };
}

const content = "first\nsecond\n}\nthird\n}\nfourth";
const context = contextFor(content);

describe("line anchors", () => {
  test("extracts one unambiguous anchor from surrounding text", async () => {
    const anchor = formatLineHashAnchor(content, 2);
    const variants = [anchor, ` ${anchor} `, `${anchor}|second`, `  ${anchor}|`];

    for (const value of variants) {
      const normalized = resolver.normalize?.(value) ?? value;
      expect(normalized).toBe(anchor);
      await expect(resolver.tryResolve(normalized, context)).resolves.toMatchObject({
        kind: "resolved",
        anchor: { value: anchor, lineNumber: 2 },
      });
    }
  });

  test("does not guess when extraction is missing or ambiguous", () => {
    const anchor = formatLineHashAnchor(content, 2);

    for (const value of ["no anchor", `x${anchor}y`, `${anchor} ${anchor}`, `use ${anchor} here`]) {
      expect(resolver.normalize?.(value)).toBe(value);
    }
  });

  test("resolves a unique line wherever it sits", async () => {
    const anchor = formatLineHashAnchor(content, 4);
    const edited = contextFor(`new 1\nnew 2\n${content}\nlast`);
    await expect(resolver.tryResolve(anchor, edited)).resolves.toMatchObject({
      kind: "resolved",
      anchor: { value: anchor, lineNumber: 6 },
    });
  });

  test("resolves each repeated line to its own position", async () => {
    const first = formatLineHashAnchor(content, 3);
    const second = formatLineHashAnchor(content, 5);
    await expect(resolver.tryResolve(first, context)).resolves.toMatchObject({
      anchor: { lineNumber: 3 },
    });
    await expect(resolver.tryResolve(second, context)).resolves.toMatchObject({
      anchor: { lineNumber: 5 },
    });
  });

  test("rejects an anchor no line produces", async () => {
    const stale = await resolver.tryResolve("ZZZZZZZ", context);
    expect(stale).toMatchObject({ kind: "rejected", rejection: { code: "stale" } });
  });

  test("rejects an anchor whose line changed", async () => {
    const anchor = formatLineHashAnchor(content, 4);
    const edited = contextFor(content.replace("third", "THIRD"));
    await expect(resolver.tryResolve(anchor, edited)).resolves.toMatchObject({
      kind: "rejected",
      rejection: { code: "stale" },
    });
  });

  test("ignores values outside the anchor format", async () => {
    await expect(resolver.tryResolve("second", context)).resolves.toEqual({ kind: "not-handled" });
    await expect(resolver.tryResolve("ZZZZZZ", context)).resolves.toEqual({ kind: "not-handled" });
    await expect(resolver.tryResolve("zzzzzzz", context)).resolves.toEqual({
      kind: "not-handled",
    });
  });

  test("renders the line number for the user", () => {
    const anchor = formatLineHashAnchor(content, 2);
    expect(
      resolver.renderCompact(anchor, {
        source: context.source,
        anchor: { value: anchor, lineNumber: 2 } as never,
      }),
    ).toBe("line 2");
    expect(
      resolver.renderFull(anchor, {
        source: context.source,
        anchor: { value: anchor, lineNumber: 2 } as never,
      }),
    ).toBe(anchor);
  });
});
