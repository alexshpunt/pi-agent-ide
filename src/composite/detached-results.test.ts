import v8 from "node:v8";
import vm from "node:vm";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { registerDetachedResults } from "./detached-results.js";

v8.setFlagsFromString("--expose-gc");
const collectGarbage = vm.runInNewContext("gc") as () => void;
const megabyte = 1024 * 1024;

function liveHeap(): number {
  collectGarbage();
  collectGarbage();
  return process.memoryUsage().heapUsed;
}

type Handler = (event: {
  details: unknown;
  structuredContent?: unknown;
}) => { details?: unknown; structuredContent?: unknown } | undefined;

function detachedResults(): Handler {
  let handler: Handler | undefined;
  const on = ((event: string, registered: Handler) => {
    if (event === "tool_result") handler = registered;
  }) as ExtensionAPI["on"];
  registerDetachedResults({ on });
  if (handler === undefined) throw new Error("No tool_result handler");
  return handler;
}

test("kept result details do not keep the file text their lines were cut from", () => {
  const handler = detachedResults();
  const kept: unknown[] = [];
  const result = (index: number) => {
    // A new 1 MB file text per result, like reads of a file that changes between edits.
    const content = `${"  value = compute(value);\n".repeat(40_000)}// version ${index}\n`;
    const lines = [{ lineNumber: 2, content: content.slice(26, 51) }];
    return { details: { lines }, structuredContent: { data: { lines } } };
  };

  kept.push(handler(result(0)));
  const afterOneResult = liveHeap();
  for (let index = 1; index <= 30; index += 1) kept.push(handler(result(index)));

  expect(liveHeap() - afterOneResult).toBeLessThan(10 * megabyte);
  const lines = [{ lineNumber: 2, content: "  value = compute(value);" }];
  expect(kept.at(-1)).toEqual({ details: { lines }, structuredContent: { data: { lines } } });
});

test("details that are not plain data stay as they are", () => {
  const handler = detachedResults();
  expect(handler({ details: { render: () => "text" } })).toBeUndefined();
  expect(handler({ details: undefined })).toBeUndefined();
});
