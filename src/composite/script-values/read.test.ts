import { describe, expect, test } from "vitest";

import { readValue } from "./read.ts";
import type { ScriptValueInput } from "./types.ts";

const uuid = "0f0e0d0c-0b0a-4908-8706-050403020100";
const shown = `<system-result note="Internal reference; not part of the file. Do not edit."><uuid>${uuid}</uuid></system-result>\nshown`;

const textData = (text: string, extra: Record<string, unknown> = {}) => ({
  kind: "text",
  source: "/w/a.json",
  text,
  lines: [],
  startLine: 1,
  endLine: 1,
  totalLines: 1,
  truncated: false,
  ...extra,
});

const scriptInput = (
  outcome: unknown,
  extra: Partial<ScriptValueInput> = {},
): ScriptValueInput => ({
  shown,
  outcome,
  content: [{ type: "text", text: "shown" }],
  details: {},
  script: true,
  ...extra,
});

describe("readValue", () => {
  test("a script's text Read resolves to its exact text and the result's id", () => {
    const text = '{\n  "a": 1\n}\n';
    const value = readValue.project(
      scriptInput({ status: "success", data: textData(text), errors: [] }),
    );
    expect(value).toEqual({ text, id: `RESULT#${uuid}` });
  });

  test("a direct Read keeps its readable result", () => {
    const outcome = { status: "success", data: textData("a"), errors: [] };
    expect(readValue.project({ ...scriptInput(outcome), script: false })).toBe(shown);
  });

  test("raw bytes resolve to base64 of every byte", () => {
    const data = {
      kind: "bytes",
      source: "raw:/w/b",
      bytes: [0, 255, 10],
      byteOffset: 0,
      byteLength: 3,
      totalBytes: 3,
      truncated: false,
    };
    expect(readValue.project(scriptInput({ status: "success", data, errors: [] }))).toEqual({
      bytes: Buffer.from([0, 255, 10]).toString("base64"),
    });
  });

  test("a directory resolves to its entries", () => {
    const data = textData("📁 /w/\n", { entries: ["src/", "a.txt"] });
    expect(readValue.project(scriptInput({ status: "success", data, errors: [] }))).toEqual({
      entries: ["src/", "a.txt"],
    });
  });

  test("an image resolves to Pi's image block; frames to images", () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    const data = { kind: "native", source: "/w/i.png", truncated: false, blocks: [] };
    const outcome = { status: "success", data, errors: [] };
    expect(readValue.project(scriptInput(outcome, { content: [image] }))).toEqual(image);
    expect(readValue.project(scriptInput(outcome, { content: [image, image] }))).toEqual({
      type: "images",
      images: [image, image],
    });
  });

  test("several selected ranges read as one text", () => {
    const data = {
      kind: "resources",
      resources: [textData("one\n"), textData("two\n")],
      truncated: false,
    };
    expect(readValue.project(scriptInput({ status: "success", data, errors: [] }))).toEqual({
      text: "one\n\ntwo\n",
      id: `RESULT#${uuid}`,
    });
  });

  test("an array path resolves to one value per path, null where a path failed", () => {
    const published: unknown[] = [];
    const ok = { status: "success", data: textData("a\n"), errors: [] };
    const missing = {
      status: "error",
      errors: [
        { code: "READ_FAILED", message: 'Read failed for "b": Source not found.', source: "b" },
      ],
    };
    const outcome = {
      status: "partial",
      data: { kind: "list", items: [ok, missing] },
      errors: missing.errors,
    };
    const input = scriptInput(outcome, {
      publish: (part) => {
        published.push(part);
        return "RESULT#item";
      },
    });
    expect(readValue.failed?.(input)).toEqual([{ text: "a\n", id: "RESULT#item" }, null]);
    expect(published).toEqual([ok]);
    expect(readValue.failureReason?.(input)).toBe('Read failed for "b": Source not found.');
  });

  test("each path of an array Read gets its own images, in path order", () => {
    const red = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    const blue = { type: "image" as const, data: "BBBB", mimeType: "image/png" };
    const native = (source: string, images: number) => ({
      status: "success",
      data: {
        kind: "native",
        source,
        truncated: false,
        blocks: Array.from({ length: images }, () => ({ type: "image", mimeType: "image/png" })),
      },
      errors: [],
    });
    const outcome = {
      status: "success",
      data: {
        kind: "list",
        items: [
          native("/w/one.png", 1),
          { status: "success", data: textData("a\n"), errors: [] },
          native("/w/frames", 2),
        ],
      },
      errors: [],
    };
    const header = (path: string) => ({ type: "text" as const, text: `--- ${path} ---` });
    const content = [
      header("one.png"),
      red,
      header("a.txt"),
      { type: "text" as const, text: "a\n" },
      header("frames"),
      blue,
      red,
    ];
    expect(
      readValue.project(scriptInput(outcome, { content, publish: () => "RESULT#item" })),
    ).toEqual([red, { text: "a\n", id: "RESULT#item" }, { type: "images", images: [blue, red] }]);
  });
});
