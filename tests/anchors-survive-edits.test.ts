import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResultTargetStore } from "pi-agent-resource";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createLineHashAnchorResolver,
  formatLineHashAnchor,
} from "#pi-agent-text-anchor-line-hash/src/anchor.ts";
import {
  TextAnchorRegistry,
  TextAnchorResolutionError,
} from "#pi-agent-text-editor/core/text-anchor-registry.ts";

const original = ["head", "alpha", "}", "beta", "}", "gamma", "tail", ""].join("\n");

describe("line hash anchors after edits elsewhere in the file", () => {
  let directory: string;
  let file: string;
  let store: ResultTargetStore;
  let registry: TextAnchorRegistry;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "anchors-survive-"));
    file = path.join(directory, "main.txt");
    writeFileSync(file, original);
    store = new ResultTargetStore();
    registry = new TextAnchorRegistry((context, lineNumber) =>
      store.relocatedLines(context.source, context.cwd, context.content, lineNumber),
    );
    registry.add({ resolver: createLineHashAnchorResolver(), kind: "line", type: "major" });
    // A Read of the file registers its text with the store.
    store.register(
      [
        {
          source: file,
          expectedContent: original,
          ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 4 } }],
        },
      ],
      directory,
    );
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const anchorFor = (content: string, lineNumber: number): string =>
    formatLineHashAnchor(lineNumber, content.split("\n")[lineNumber - 1] ?? "");

  function resolve(anchor: string, content: string) {
    writeFileSync(file, content);
    return registry.snapshot().resolve(anchor, {
      source: file,
      content,
      lines: content.split("\n"),
      cwd: directory,
    });
  }

  test("move to the new line when lines were added above", async () => {
    const edited = `new 1\nnew 2\n${original}`;
    await expect(resolve(anchorFor(original, 4), edited)).resolves.toMatchObject({
      lineNumber: 6,
    });
  });

  test("keep the line when only lines below changed", async () => {
    const edited = original.replace("tail", "tail\ntail 2");
    await expect(resolve(anchorFor(original, 4), edited)).resolves.toMatchObject({
      lineNumber: 4,
    });
  });

  test("follow the line after edits above and below at once", async () => {
    const edited = `new\n${original.replace("gamma", "g1\ng2")}`;
    await expect(resolve(anchorFor(original, 4), edited)).resolves.toMatchObject({
      lineNumber: 5,
    });
  });

  test("tell repeated lines apart by their position", async () => {
    const edited = `}\n${original}`;
    await expect(resolve(anchorFor(original, 5), edited)).resolves.toMatchObject({
      lineNumber: 6,
    });
    await expect(resolve(anchorFor(original, 3), edited)).resolves.toMatchObject({
      lineNumber: 4,
    });
  });

  test("use an anchor issued several versions ago", async () => {
    const anchor = anchorFor(original, 6);
    const second = `a\n${original}`;
    await expect(resolve(anchorFor(original, 4), second)).resolves.toMatchObject({
      lineNumber: 5,
    });
    const third = `a\nb\n${original.replace("head", "HEAD")}`;
    await expect(resolve(anchor, third)).resolves.toMatchObject({ lineNumber: 8 });
  });

  test("still reject an anchor whose own line changed", async () => {
    const edited = `new\n${original.replace("beta", "BETA")}`;
    const rejection = await resolve(anchorFor(original, 4), edited).catch(
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(TextAnchorResolutionError);
    expect(rejection).toMatchObject({ rejection: { code: "stale" } });
  });

  test("still reject an anchor whose line was deleted", async () => {
    const edited = original.replace("beta\n", "");
    await expect(resolve(anchorFor(original, 4), edited)).rejects.toMatchObject({
      rejection: { code: "stale" },
    });
  });

  test("still reject an anchor beyond the end when its line is gone", async () => {
    const edited = original.replace("gamma\ntail\n", "");
    await expect(resolve(anchorFor(original, 7), edited)).rejects.toMatchObject({
      rejection: { code: "missing" },
    });
  });

  test("do not guess for a file the store never saw", async () => {
    const other = path.join(directory, "other.txt");
    writeFileSync(other, original);
    const edited = `new\n${original}`;
    writeFileSync(other, edited);
    await expect(
      registry.snapshot().resolve(anchorFor(original, 4), {
        source: other,
        content: edited,
        lines: edited.split("\n"),
        cwd: directory,
      }),
    ).rejects.toMatchObject({ rejection: { code: "stale" } });
  });
});
