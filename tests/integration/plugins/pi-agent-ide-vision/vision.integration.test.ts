import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

const extension = path.resolve("src/pi-agent-ide.ts");

test("discovers processes and reads PID metadata through real Pi tools", async () => {
  const result = await new PiIntegrationTest({
    testName: "vision-process-metadata",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: process.cwd(),
    extensions: [extension],
    tools: ["search", "read"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "find-process",
            name: "search",
            arguments: { query: `process:${process.pid}` },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage(
        [
          toolCall({
            id: "read-process",
            name: "read",
            arguments: { path: `process:${process.pid}` },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Inspect this Pi process");

  expect(getToolExecution(result, "find-process").isError).toBe(false);
  expect(getToolResultText(result, "find-process")).toContain(`PID: ${process.pid}`);
  expect(getToolResultText(result, "read-process")).toContain("Owned by Agent IDE: no");
});

test("denies display capture before touching the desktop backend", async () => {
  const result = await new PiIntegrationTest({
    testName: "vision-display-denied",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: process.cwd(),
    extensions: [extension],
    tools: ["read"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "capture-display",
            name: "read",
            arguments: { path: "display:" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Denied")]),
    ],
  }).run("Capture the full display");

  expect(getToolExecution(result, "capture-display").isError).toBe(true);
});

test("denies arbitrary window capture before touching the desktop backend", async () => {
  const result = await new PiIntegrationTest({
    testName: "vision-window-denied",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: process.cwd(),
    extensions: [extension],
    tools: ["read"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "capture-window",
            name: "read",
            arguments: { path: `window:${process.pid}` },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Denied")]),
    ],
  }).run("Capture an arbitrary process window");

  expect(getToolExecution(result, "capture-window").isError).toBe(true);
});
