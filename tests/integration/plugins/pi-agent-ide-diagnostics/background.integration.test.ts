import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { generateReadExtensions } from "pi-agent-read/testing";
import type { DiagnosticEntryData } from "#src/core/diagnostic-entry.js";
import { PiRun } from "pi-coding-agent-test/base";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";

const extensions = await generateReadExtensions([
  "tests/integration/extensions/pi-agent-text-editor/register-extension.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
  "src/core/extension.ts",
  "src/plugins/pi-agent-ide-diagnostics/index.ts",
  "tests/integration/fixtures/background-diagnostics.ts",
]);
afterAll(() => extensions.dispose());

test("pending diagnostics stay explicit in ranged and empty-file views", async () => {
  const root = path.resolve(".agents/tmp/background-integration");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "range-"));
  try {
    await writeFile(path.join(cwd, "range.ts"), "one\ntwo\nthree\n");
    await writeFile(path.join(cwd, "empty.ts"), "");
    const result = await new PiIntegrationTest({
      testName: "pending-diagnostic-views",
      cwd,
      extensions: extensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "ranged",
              name: "read",
              arguments: { path: "range.ts", offset: 2, limit: 1, views: ["diagnostics"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "empty",
              name: "read",
              arguments: { path: "empty.ts", views: ["diagnostics"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Read unfinished diagnostics.")]),
      ],
    }).run("Read pending diagnostics without reporting a clean file.");
    for (const id of ["ranged", "empty"]) {
      expect(getToolExecution(result, id).isError).toBe(false);
      expect(getToolResultText(result, id)).toContain("lsp: pending");
      expect(getToolResultText(result, id)).not.toContain("No diagnostics.");
    }
    expect(getToolResultText(result, "ranged")).toContain("two");
    expect(getToolResultText(result, "ranged")).not.toContain("three");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("a formatter's syntax rejection keeps the successful edit saved", async () => {
  const root = path.resolve(".agents/tmp/background-integration");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "syntax-"));
  const file = path.join(cwd, "example.ts");
  try {
    await writeFile(file, "initial\n");
    const result = await new PiIntegrationTest({
      testName: "syntax-rejection-keeps-edit",
      cwd,
      extensions: extensions.paths,
      tools: ["replace", "read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "invalid",
              name: "replace",
              arguments: { path: "example.ts", start: "initial", text: "SYNTAX_INVALID   " },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The invalid edit remains saved.")]),
      ],
    }).run("Save an edit whose syntax the formatter cannot parse.");
    expect(getToolExecution(result, "invalid").isError).toBe(false);
    expect(await readFile(file, "utf8")).toBe("SYNTAX_INVALID   \n");
    expect(getToolResultText(result, "invalid")).toContain("SYNTAX_INVALID");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("real Pi receives immediate findings during edits while empty and stale reports stay silent", async () => {
  const root = path.resolve(".agents/tmp/background-integration");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "project-"));
  const file = path.join(cwd, "example.ts");
  await writeFile(file, "initial\n");
  const call = (id: string, name: string, args: Record<string, unknown>) =>
    assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
  const edit = (id: string, start: string, value: string) =>
    call(id, "replace", { path: "example.ts", start, text: `${value}   ` });
  try {
    const result = await new PiIntegrationTest({
      testName: "background-diagnostics",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: extensions.paths,
      tools: ["read", "replace", "diagnostic_control"],
      rawMode: false,
      conversation: [
        edit("edit-a", "initial", "A"),
        call("started", "diagnostic_control", { action: "started" }),
        call("unavailable", "diagnostic_control", { action: "unavailable" }),
        edit("edit-b", "A", "B"),
        call("partial", "diagnostic_control", { action: "partial" }),
        call("complete", "diagnostic_control", { action: "complete" }),
        call("focused", "read", { path: "diagnostics:example.ts" }),
        call("annotated", "read", { path: "example.ts", views: ["diagnostics"] }),
        call("repeat", "diagnostic_control", { action: "repeat" }),
        edit("edit-c", "B", "C"),
        call("clear", "diagnostic_control", { action: "clear" }),
        call("clean", "read", { path: "diagnostics:example.ts" }),
        assistantMessage([text("Finished the diagnostic scenario.")]),
      ],
    }).run("Edit and format the file, then inspect diagnostics when ready.");
    for (const id of ["edit-a", "edit-b", "edit-c"]) {
      expect(getToolExecution(result, id).isError).toBe(false);
      const output = getToolResultText(result, id);
      expect(output).not.toContain("<!-- lsp:");
      expect(output).not.toContain("detail only on explicit read");
      expect(output).not.toMatch(/[ABC] {3}/u);
    }
    expect(getToolResultText(result, "partial")).toContain("lsp:pending,lint:ready");
    for (const id of ["focused", "annotated"]) {
      expect(getToolResultText(result, id)).toContain("error detail only on explicit read");
      expect(getToolResultText(result, id)).toContain("warning detail only on explicit read");
    }
    expect(getToolResultText(result, "clean")).toContain("No diagnostics.");
    expect(await readFile(file, "utf8")).toBe("C\n");
    const captured = await PiRun.open(result.artifacts.run);
    if (!captured.session) throw new Error("Missing session capture");
    const notifications = captured.session
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; customType?: string; display?: boolean })
      .filter((entry) => entry.type === "custom_message" && entry.customType === "ide-diagnostics");
    // Pending, unavailable, repeated and cleared reports add no automatic messages.
    expect(notifications).toHaveLength(2);
    expect(notifications.every((entry) => entry.display === false)).toBe(true);
    const entries = captured.session
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            customType?: string;
            message?: { toolCallId?: string };
          },
      );
    // The UI receives the finding while the control tool is still waiting, not at the next model call.
    expect(
      entries.findIndex((entry) => entry.customType === "ide-diagnostic-summary"),
    ).toBeLessThan(entries.findIndex((entry) => entry.message?.toolCallId === "partial"));
    const lastMessages = result.providerRequests.at(-1)?.messages as { role: string }[];
    expect(lastMessages.filter((message) => message.role === "user")).toHaveLength(3);
    const summaries = captured.session
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { type: string; customType?: string; data?: DiagnosticEntryData },
      )
      .filter((entry) => entry.type === "custom" && entry.customType === "ide-diagnostic-summary");
    expect(summaries.map((entry) => entry.data)).toEqual([
      {
        filePath: "example.ts",
        sources: [
          { source: "lint", status: "ready", counts: { error: 0, warning: 1, info: 0, hint: 0 } },
        ],
      },
      {
        filePath: "example.ts",
        sources: [
          { source: "lsp", status: "ready", counts: { error: 1, warning: 0, info: 0, hint: 0 } },
          { source: "lint", status: "ready", counts: { error: 0, warning: 1, info: 0, hint: 0 } },
        ],
      },
    ]);
    // Thirteen scripted turns plus preflight/postflight; duplicate and empty updates add no turns.
    expect(result.providerRequests).toHaveLength(15);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
