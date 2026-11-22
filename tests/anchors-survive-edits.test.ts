import { describe, expect, test } from "vitest";

import {
  createLineHashAnchorResolver,
  formatLineHashAnchor,
} from "#pi-agent-text-anchor-line-hash/src/anchor.ts";
import {
  TextAnchorRegistry,
  TextAnchorResolutionError,
} from "#pi-agent-text-editor/core/text-anchor-registry.ts";

const original = ["head", "alpha", "}", "beta", "}", "gamma", "tail", ""].join("\n");

describe("line anchors after edits elsewhere in the file", () => {
  const registry = new TextAnchorRegistry();
  registry.add({ resolver: createLineHashAnchorResolver(), kind: "line", type: "major" });

  function resolve(anchor: string, content: string) {
    return registry.snapshot().resolve(anchor, {
      source: "main.txt",
      content,
      lines: content.split("\n"),
      cwd: "/workspace",
    });
  }

  test("follow a unique line when lines are added above", async () => {
    const edited = `new 1\nnew 2\n${original}`;
    await expect(resolve(formatLineHashAnchor(original, 4), edited)).resolves.toMatchObject({
      lineNumber: 6,
    });
  });

  test("follow a unique line after edits above and below at once", async () => {
    const edited = `new\n${original.replace("gamma", "g1\ng2")}`;
    await expect(resolve(formatLineHashAnchor(original, 4), edited)).resolves.toMatchObject({
      lineNumber: 5,
    });
  });

  test("tell repeated lines apart after a line is inserted above them", async () => {
    const edited = `new\n${original}`;
    await expect(resolve(formatLineHashAnchor(original, 5), edited)).resolves.toMatchObject({
      lineNumber: 6,
    });
    await expect(resolve(formatLineHashAnchor(original, 3), edited)).resolves.toMatchObject({
      lineNumber: 4,
    });
  });

  test("keep a repeated line when another copy is added elsewhere", async () => {
    const edited = original.replace("tail", "tail\n}");
    await expect(resolve(formatLineHashAnchor(original, 5), edited)).resolves.toMatchObject({
      lineNumber: 5,
    });
  });

  test("use an anchor issued several versions ago", async () => {
    const anchor = formatLineHashAnchor(original, 6);
    const edited = `a\nb\n${original.replace("head", "HEAD")}`;
    await expect(resolve(anchor, edited)).resolves.toMatchObject({ lineNumber: 8 });
  });

  test("reject an anchor whose own line changed", async () => {
    const edited = `new\n${original.replace("beta", "BETA")}`;
    const rejection = await resolve(formatLineHashAnchor(original, 4), edited).catch(
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(TextAnchorResolutionError);
    expect(rejection).toMatchObject({ rejection: { code: "stale" } });
  });

  test("reject an anchor whose line was deleted", async () => {
    const edited = original.replace("beta\n", "");
    await expect(resolve(formatLineHashAnchor(original, 4), edited)).rejects.toMatchObject({
      rejection: { code: "stale" },
    });
  });
});
