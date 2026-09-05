import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "#integration/support/pi-runtime/pi-coding-agent-test.js";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { expectToolRowsPreserveBackground } from "#integration/support/tui-background.js";

const extensions = createExtensionSet();
const defaultTextEditorExtension = path.resolve(
  process.cwd(),
  "tests/integration/extensions/pi-agent-text-editor/register-extension.ts",
);
const rendererTestStand = path.resolve(import.meta.dirname, "register-extension.ts");
const overwriteGuardExtension = path.resolve(
  process.cwd(),
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-overwrite/index.ts",
);
const staleAnchorGuardExtension = path.resolve(
  process.cwd(),
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-stale-anchor/index.ts",
);

interface PersistedSessionEntry {
  readonly type: string;
  readonly message?: {
    readonly role?: string;
    readonly toolName?: string;
    readonly details?: {
      readonly mutationRender?: readonly { readonly path: string; readonly model: unknown }[];
    };
  };
}

const runFile = promisify(execFile);
const piTestCommand = path.resolve(process.cwd(), "node_modules/.bin/pi-test");

describe("text mutation renderer", () => {
  test.each([
    ["compact", 1],
    ["compact", 200],
    ["compact", 600],
    ["compact", 1_000],
    ["expanded", 1],
    ["expanded", 200],
    ["expanded", 600],
    ["expanded", 1_000],
  ])(
    "TS-05 streams %s native-TUI writes at %d rows",
    async (mode, lineCount) => {
      await withTempWorkspace(async (directory) => {
        const content = largeWriteContent(lineCount);
        await createFixture(directory, "large-write.txt", "");
        await createFixture(directory, "stream-ahead.txt", "next tool\n");
        const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
        await mkdir(configDirectory, { recursive: true });
        await writeFile(
          path.join(configDirectory, "text-editor.json"),
          JSON.stringify({ renderer: { diffView: mode === "expanded" ? "full" : "compact" } }),
          "utf8",
        );
        const args = { path: "large-write.txt", content };
        const argumentsJson = JSON.stringify(args);
        const marker = '"content":"';
        const valueStart = argumentsJson.indexOf(marker) + marker.length;
        const encoded = JSON.stringify(content).slice(1, -1);
        const valueEnd = valueStart + encoded.length;
        const lines = content
          .slice(0, -1)
          .split("\n")
          .map((line) => `${line}\n`);
        const chunks = [
          argumentsJson.slice(0, valueStart),
          ...lines.map((line) => JSON.stringify(line).slice(1, -1)),
          argumentsJson.slice(valueEnd),
        ];
        const snapshots = [
          { ...args, content: "" },
          ...lines.map((_, index) => ({
            ...args,
            content: content.slice(0, lines.slice(0, index + 1).join("").length),
          })),
          args,
        ];
        const result = await runInSeparatePi(() =>
          new PiIntegrationTest({
            testName: `text-editor-renderer-large-write-${mode}-${lineCount}`,
            cwd: directory,
            extensions: extensions.paths.map((extension) =>
              extension === defaultTextEditorExtension ? rendererTestStand : extension,
            ),
            tools: ["write", "read"],
            rawMode: false,
            environment: { PI_AGENT_IDE_TEST_EXPANDED: mode === "expanded" ? "1" : "0" },
            timeoutMs: 180_000,
            conversation: [
              assistantMessage(
                [
                  toolCall({
                    id: `large-write-${mode}-${lineCount}`,
                    name: "write",
                    argumentsJson,
                    chunks: { kind: "explicit", chunks },
                    argumentSnapshots: snapshots,
                    delayMs: 0,
                  }),
                  toolCall({
                    id: `stream-ahead-${mode}-${lineCount}`,
                    name: "read",
                    arguments: { path: "stream-ahead.txt" },
                  }),
                ],
                { stopReason: "toolUse" },
              ),
              assistantMessage([text("Done")], {
                delayMs: rendererObservationWindowMs(),
              }),
            ],
          }).run(`Write ${lineCount} lines with animated native output`),
        );

        const replay = await replaySynchronizedFrames(result.artifacts.run, result.frameDelaysMs);
        const quiescence = verifyLargeWriteQuiescence({
          mode,
          lineCount,
          frames: replay.frames,
          finalScreen: replay.finalScreen,
          capturedScreen: result.tuiRenderedOutput,
          frameDelaysMs: result.frameDelaysMs,
          traceEvents: result.traceEvents,
          state: result.state,
          expectSuccessor: true,
        });
        const maxGap = Math.max(...result.frameDelaysMs, 0);
        const metrics = {
          mode,
          lineCount,
          frameCount: result.frameDelaysMs.length,
          maximumGapMs: maxGap,
          medianGapMs: median(result.frameDelaysMs),
          totalRecordedFrameTimeMs: result.frameDelaysMs.reduce((sum, gap) => sum + gap, 0),
          // Renderer counters are isolated by TS-03; the real-Pi boundary has no production hook.
          projectionFallbackCount: "sourced by TS-03 unit counter",
          newRowCount: "sourced by TS-03 unit counter",
          highlightedRowCount: "sourced by TS-03 unit counter",
          quiescence,
        };
        await writeFile(
          path.join(result.artifacts.directory, "metrics.json"),
          JSON.stringify(metrics, null, 2) + "\n",
          "utf8",
        );

        await expect
          .soft(readFile(path.join(directory, "large-write.txt")))
          .resolves.toEqual(Buffer.from(content, "utf8"));
        const toolId = `large-write-${mode}-${lineCount}`;
        expect.soft(getToolExecution(result, toolId).isError).toBe(false);

        expect
          .soft(getToolExecution(result, `stream-ahead-${mode}-${lineCount}`).isError)
          .toBe(false);
        expect.soft(result.terminalOutput).toContain("▌");
        expect.soft(result.terminalOutput).toContain(`row ${String(lineCount).padStart(4, "0")}`);
        expect.soft(replay.finalScreen).toBe(result.tuiRenderedOutput);
        expect.soft(replay.finalScreen).not.toContain("▌");
        expect.soft(replay.finalScreen).toContain(`+${lineCount} ~0 -0`);
        expect.soft(replay.finalScreen).toContain(`row ${String(lineCount).padStart(4, "0")}`);
        expect.soft(result.traceEvents.some((event) => event.type === "message_update")).toBe(true);
        expect
          .soft(result.traceEvents.some((event) => event.type === "tool_execution_end"))
          .toBe(true);
        if (mode === "expanded") {
          expect.soft(replay.finalScreen).toContain("row 0001");
        } else if (lineCount > 1) {
          expect.soft(replay.finalScreen).toContain("lines omitted");
        }
      });
    },
    180_000,
  );

  test("TS-05 rejects a stalled capture as quiescent", () => {
    const stalled = "write large-write.txt +0 ~1 -0\nrow 0001\n▌";

    expect(() =>
      verifyLargeWriteQuiescence({
        mode: "expanded",
        lineCount: 2,
        frames: [
          { frame: 1, streamOffset: 100, text: stalled },
          { frame: 2, streamOffset: 200, text: stalled },
        ],
        finalScreen: stalled,
        capturedScreen: stalled,
        frameDelaysMs: [0, 20],
        traceEvents: [
          {
            type: "tool_execution_end",
            sequence: 1,
            timestamp: 100,
            event: { toolCallId: "large-write-expanded-2" },
          },
          { type: "agent_settled", sequence: 2, timestamp: 120 },
        ],
        state: { isIdle: true, hasPendingMessages: false },
      }),
    ).toThrow(/typing cursor after the observation window/u);
  });

  test("TS-05 ignores unrelated terminal chrome after mutation quiescence", () => {
    const panel = [
      "write large-write.txt +2 ~0 -0",
      "╭────╮",
      "│ 1 + row 0001 │",
      "│ 2 + row 0002 │",
      "╰────╯",
    ].join("\n");
    const result = verifyLargeWriteQuiescence({
      mode: "expanded",
      lineCount: 2,
      frames: [
        { frame: 1, streamOffset: 100, text: "row 0001\n▌" },
        { frame: 2, streamOffset: 200, text: "row 0001\nrow 0002\n▌" },
        { frame: 3, streamOffset: 300, text: `old help row\n${panel}` },
      ],
      finalScreen: `new help row\n${panel}`,
      capturedScreen: `new help row\n${panel}`,
      frameDelaysMs: [0, 20, 20],
      traceEvents: [
        {
          type: "tool_execution_end",
          sequence: 1,
          timestamp: 100,
          event: { toolCallId: "large-write-expanded-2" },
        },
        { type: "agent_settled", sequence: 2, timestamp: 120 },
      ],
      state: { isIdle: true, hasPendingMessages: false },
    });

    expect(result.quiescentFrame).toBe(3);
  });

  test("shows the real replacement as a stable compact diff panel", async () => {
    await withTempWorkspace(async (directory) => {
      const source =
        Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
      const file = await createFixture(directory, "stable.txt", source);
      const relativeFile = path.relative(directory, file);
      const result = await new PiIntegrationTest({
        testName: "text-editor-stable-renderer",
        cwd: directory,
        extensions: [
          ...extensions.paths.map((extension) =>
            extension === defaultTextEditorExtension ? rendererTestStand : extension,
          ),
          staleAnchorGuardExtension,
        ],
        tools: ["replace", "read"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "replace-stable",
                name: "replace",
                arguments: {
                  path: relativeFile,
                  start: formatLineHashAnchor(27, "line 27"),
                  text: "latest visible change",
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Replace the requested line");

      const rendered = result.tuiRenderedOutput;
      expect(getToolExecution(result, "replace-stable").isError).toBe(false);
      expect(rendered).toContain("╭");
      expect(rendered).toContain("stable.txt");
      expect(rendered).toContain("latest visible change");
      expect(rendered).not.toContain("← ⊘ Blocked");
      const panelStart = rendered.indexOf("╭─", rendered.indexOf("replace stable.txt · "));
      const panelEnd = rendered.indexOf("╯", panelStart);
      const panel = rendered.slice(panelStart, panelEnd + 1);
      expect(rendered).toContain("replace stable.txt · line 27");
      expect(rendered).toContain("+0 ~1 -0");
      expect(rendered.match(/╭─{40,}╮/gu)).toHaveLength(1);
      expect(panel).toMatch(/27\s+~\s+latest visible change/u);
      expect(panel).not.toContain("line 27");
      expect(panel).toContain("line 25");
      expect(panel).toContain("line 26");
      expect(panel).toContain("line 28");
      expect(panel).toContain("line 29");
      expect(panel).not.toContain("line 24");
      expect(panel).not.toContain("line 30");
      expect(panel).not.toContain("stable.txt");
      expect(panel).not.toMatch(/\+\d+ ~\d+ -\d+/u);
      expect(panel).not.toMatch(/scope-(?:begin|end)|\d+#[A-Z0-9]{3,4}/u);
    });
  });

  test("wraps long diff rows in the real native renderer", async () => {
    await withTempWorkspace(async (directory) => {
      const before = [
        `const message = "${"alpha beta ".repeat(20)}before";`,
        `const removed = "${"https://example.com/".repeat(8)}";`,
      ].join("\n");
      const after = `const message = "${"alpha beta ".repeat(20)}after";`;
      const file = await createFixture(directory, "long-wrap.ts", `${before}\n`);
      const relativeFile = path.relative(directory, file);
      const result = await new PiIntegrationTest({
        testName: "text-editor-renderer-word-wrap",
        cwd: directory,
        extensions: extensions.paths.map((extension) =>
          extension === defaultTextEditorExtension ? rendererTestStand : extension,
        ),
        tools: ["write"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "write-word-wrap",
                name: "write",
                arguments: { path: relativeFile, content: `${after}\n` },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Replace the long diff");

      const panels = mutationPanels(result.tuiRenderedOutput, "write long-wrap.ts");
      expect(getToolExecution(result, "write-word-wrap").isError).toBe(false);
      expect(panels).toHaveLength(1);
      const panelLines = stripTerminalSequences(panels[0] ?? "").split("\n");
      const body = panelLines.slice(1, -1);
      const firstSegments = body.filter((line) => /^\s*│\s+\d+\s[+~-] /u.test(line));
      const panelWidth = visibleWidth(panelLines[0] ?? "");

      const bodyWidth = visibleWidth(body[0] ?? "");
      expect(panelWidth).toBeGreaterThanOrEqual(40);
      expect(body.every((line) => visibleWidth(line) === bodyWidth)).toBe(true);
      expect(body.every((line) => line.trimEnd().endsWith("│"))).toBe(true);
      expect(firstSegments).toEqual([
        expect.stringMatching(/^\s*│\s+1 ~ /u),
        expect.stringMatching(/^\s*│\s+2 - /u),
      ]);
      expect(body.filter((line) => /^\s*│\s+\d+\s[+~-] /u.test(line))).toHaveLength(2);
      expect(body.length).toBeGreaterThan(firstSegments.length);
      expect(stripTerminalSequences(panels[0] ?? "")).toContain("https://example.com/");
      await expect(readFile(file, "utf8")).resolves.toBe(`${after}\n`);
    });
  });

  test("keeps the enclosing background in the self-rendered write shell", async () => {
    await withTempWorkspace(async (directory) => {
      const fileName = `inherited-background-${"long-name-".repeat(20)}.ts`;
      const file = await createFixture(directory, fileName, "export const value = 1;\n");
      const result = await new PiIntegrationTest({
        testName: "text-editor-renderer-inherited-background",
        cwd: directory,
        extensions: extensions.paths.map((extension) =>
          extension === defaultTextEditorExtension ? rendererTestStand : extension,
        ),
        tools: ["write"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "write-inherited-background",
                name: "write",
                arguments: { path: fileName, content: "export const value = 2;\n" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Replace the file with the long name");

      expect(getToolExecution(result, "write-inherited-background").isError).toBe(false);
      const backgrounds = expectToolRowsPreserveBackground(
        result.terminalOutput,
        "inherited-background-",
      );
      expect(backgrounds.at(-1)).not.toBe(backgrounds[0]);
      await expect(readFile(file, "utf8")).resolves.toBe("export const value = 2;\n");
    });
  });

  test("shows the complete growing write in every active frame", async () => {
    await withTempWorkspace(async (directory) => {
      const streamedLines = Array.from(
        { length: 20 },
        (_, index) => `streamed line ${String(index + 1).padStart(2, "0")}`,
      );
      const content = streamedLines.join("\n");
      const arguments_ = { path: ".agents/tmp/growing-write.txt", content };
      const argumentsJson = JSON.stringify(arguments_);
      const contentMarker = '"content":"';
      const contentStart = argumentsJson.indexOf(contentMarker) + contentMarker.length;
      const encodedContent = JSON.stringify(content).slice(1, -1);
      const contentEnd = contentStart + encodedContent.length;
      const lines = content
        .split("\n")
        .map((line, index, all) => (index === all.length - 1 ? line : `${line}\n`));
      const chunks = [
        argumentsJson.slice(0, contentStart),
        ...lines.map((line) => JSON.stringify(line).slice(1, -1)),
        argumentsJson.slice(contentEnd),
      ];
      const argumentSnapshots = [
        { ...arguments_, content: "" },
        ...lines.map((_, index) => ({
          ...arguments_,
          content: lines.slice(0, index + 1).join(""),
        })),
        arguments_,
      ];
      const result = await new PiIntegrationTest({
        testName: "text-editor-renderer-complete-growing-write",
        cwd: directory,
        extensions: extensions.paths.map((extension) =>
          extension === defaultTextEditorExtension ? rendererTestStand : extension,
        ),
        tools: ["write"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "complete-growing-write",
                name: "write",
                argumentsJson,
                chunks: { kind: "explicit", chunks },
                argumentSnapshots,
                delayMs: 0,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Write all 20 streamed lines");

      const rendered = result.tuiRenderedOutput;

      const replay = await replaySynchronizedFrames(result.artifacts.run, result.frameDelaysMs);
      const firstLine = streamedLines[0] ?? "";
      const secondLine = streamedLines[1] ?? "";
      const activeFrames = replay.frames.filter(
        ({ text: frameText }) =>
          frameText.includes("write .agents/tmp/growing-write.txt") && frameText.includes("▌"),
      );
      const earlyFrame = activeFrames.find(({ text: frameText }) => frameText.includes(secondLine));
      const lateActiveFrame = activeFrames.at(-1);
      expect(earlyFrame).toBeDefined();
      expect(lateActiveFrame).toBeDefined();
      const firstCompletedRow = (frame: ReplayedFrame | undefined) =>
        stripTerminalSequences(frame?.text ?? "")
          .split("\n")
          .find((line) => line.includes(firstLine));
      expect(firstCompletedRow(lateActiveFrame)).toBe(firstCompletedRow(earlyFrame));
      for (const frame of activeFrames) {
        const completeLineNumbers = [...frame.text.matchAll(/streamed line (\d{2})/gu)].map(
          (match) => Number(match[1]),
        );
        const lastCompleteLine = Math.max(...completeLineNumbers, 0);
        for (const line of streamedLines.slice(0, lastCompleteLine)) {
          expect(frame.text).toContain(line);
        }
        expect(frame.text).not.toContain("lines omitted");
      }
      const completeFrame = replay.frames.at(-1);
      for (const line of streamedLines) {
        expect(completeFrame?.text).toContain(line);
      }
      expect(result.terminalOutput).not.toContain("\u001B[3J");
      expect(getToolExecution(result, "complete-growing-write").isError).toBe(false);
      await expect(
        readFile(path.join(directory, ".agents/tmp/growing-write.txt"), "utf8"),
      ).resolves.toBe(content);
      expect(rendered.match(/write \.agents\/tmp\/growing-write\.txt/gu)).toHaveLength(1);
      expect(mutationPanels(rendered, "write .agents/tmp/growing-write.txt")).toHaveLength(1);
      expect(rendered).toContain("+20 ~0 -0");
      expect(rendered).not.toContain("▌");
    });
  });

  test("streams a diff for a mutation with an inherited path", async () => {
    await withTempWorkspace(async (directory) => {
      const source = Array.from(
        { length: 24 },
        (_, index) => `const value${index + 1} = ${index + 1};`,
      ).join("\n");
      await createFixture(directory, "inherited-path.ts", source);
      const result = await new PiIntegrationTest({
        testName: "text-editor-renderer-inherited-path-streaming",
        cwd: directory,
        extensions: extensions.paths.map((extension) =>
          extension === defaultTextEditorExtension ? rendererTestStand : extension,
        ),
        tools: ["replace", "read"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "replace-inherited-first",
                name: "replace",
                arguments: {
                  path: "inherited-path.ts",
                  start: formatLineHashAnchor(4, "const value4 = 4;"),
                  text: "const value4 = loadPrimaryValue();",
                },
                delayMs: 0,
              }),
              toolCall({
                id: "replace-inherited-second",
                name: "replace",
                arguments: {
                  start: formatLineHashAnchor(18, "const value18 = 18;"),
                  text: "const value18 = loadStreamedInheritedValue();",
                },
                chunks: { kind: "fixed", size: 3 },
                delayMs: 25,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Replace two values and inherit the path for the second call");

      const rendered = result.tuiRenderedOutput;
      const finalContent = await readFile(path.resolve(directory, "inherited-path.ts"), "utf8");
      expect(getToolExecution(result, "replace-inherited-first").isError).toBe(false);
      expect(getToolExecution(result, "replace-inherited-second").isError).toBe(false);
      expect(finalContent).toContain("const value4 = loadPrimaryValue();");
      expect(finalContent).toContain("const value18 = loadStreamedInheritedValue();");
      expect(mutationPanels(rendered, "replace inherited-path.ts · ")).toHaveLength(2);
    });
  });

  test("keeps every user-facing viewport while collapsing agent results by file", async () => {
    await withTempWorkspace(async (directory) => {
      const source = Array.from(
        { length: 32 },
        (_, index) => `const value${index + 1} = ${index + 1};`,
      ).join("\n");
      await createFixture(directory, "post-edit-viewport.ts", source);
      const result = await new PiIntegrationTest({
        testName: "text-editor-renderer-batched-viewports",
        cwd: directory,
        extensions: extensions.paths.map((extension) =>
          extension === defaultTextEditorExtension ? rendererTestStand : extension,
        ),
        tools: ["replace", "read"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "replace-first-viewport",
                name: "replace",
                arguments: {
                  path: "post-edit-viewport.ts",
                  start: formatLineHashAnchor(7, "const value7 = 7;"),
                  text: "const value7 = loadPrimaryValue();",
                },
              }),
              toolCall({
                id: "replace-second-viewport",
                name: "replace",
                arguments: {
                  path: "post-edit-viewport.ts",
                  start: formatLineHashAnchor(25, "const value25 = 25;"),
                  text: "const value25 = loadSecondaryValue();",
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Replace two distant values in one response");
      const rendered = result.tuiRenderedOutput;
      const panels = mutationPanels(rendered, "replace post-edit-viewport.ts · ");
      const finalContent = await readFile(path.resolve(directory, "post-edit-viewport.ts"), "utf8");

      expect(rendered.match(/replace post-edit-viewport\.ts · line \d+/gu)).toHaveLength(2);
      expect(rendered.match(/\+0 ~1 -0/gu)).toHaveLength(2);
      expect(panels).toHaveLength(2);
      expect(panels[0]).toContain("loadPrimaryValue");
      expect(panels[0]).not.toContain("loadSecondaryValue");
      expect(panels[1]).toContain("loadSecondaryValue");
      expect(panels[1]).not.toContain("loadPrimaryValue");
      expect(finalContent).toContain("loadPrimaryValue");
      expect(finalContent).toContain("loadSecondaryValue");
      expect(finalContent).toContain("formatted outside generated viewport");

      expect(rendered).not.toContain(
        "final file result is in the last successful tool call for that file",
      );
      expect(getToolResultText(result, "replace-first-viewport")).toContain(
        "final file result is in the last successful tool call for that file",
      );
      expect(getToolResultText(result, "replace-second-viewport")).toContain(
        "formatted outside generated viewport",
      );
      expect(getToolResultText(result, "replace-second-viewport")).toContain("formattedContext");
    });
  });

  test("streams replacement text as overwrite typing with a cursor", async () => {
    await withTempWorkspace(async (directory) => {
      const before = [
        "export function buildService() {",
        "    const endpoint = resolveEndpoint();",
        "    const retries = resolveRetries();",
        "    const timeout = resolveTimeout();",
        "    const transport = createTransport(endpoint);",
        "    const service = new Service(transport);",
        "    return service.withRetry(retries).withTimeout(timeout);",
        "}",
      ].join("\n");
      await createFixture(directory, "streaming.ts", before);
      const arguments_ = {
        path: "streaming.ts",
        start: formatLineHashAnchor(3, "    const retries = resolveRetries();"),
        end: formatLineHashAnchor(6, "    const service = new Service(transport);"),
        text: ["    const retryLimit = 3;", "    const timeoutMs = 5_000;"].join("\n"),
      };
      const argumentsJson = JSON.stringify(arguments_);
      const textStart = argumentsJson.indexOf('"text":') + '"text":"'.length;
      const chunks = [
        argumentsJson.slice(0, textStart),
        argumentsJson.slice(textStart, textStart + 16),
        argumentsJson.slice(textStart + 16, textStart + 42),
        argumentsJson.slice(textStart + 42),
      ];
      const argumentSnapshots = [
        { ...arguments_, text: "" },
        { ...arguments_, text: "    const retry" },
        { ...arguments_, text: "    const retryLimit = 3;\n    const" },
        arguments_,
      ];
      const result = await new PiIntegrationTest({
        testName: "text-editor-renderer-streaming-overwrite",
        cwd: directory,
        extensions: extensions.paths.map((extension) =>
          extension === defaultTextEditorExtension ? rendererTestStand : extension,
        ),
        tools: ["replace", "read"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "replace-streaming",
                name: "replace",
                argumentsJson,
                chunks: { kind: "explicit", chunks },
                argumentSnapshots,
                delayMs: 40,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Replace the service setup");

      expect(result.terminalOutput).toContain("▌");
      expect(stripTerminalSequences(result.terminalOutput)).not.toMatch(
        /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \+\d+ ~\d+ -\d+/u,
      );
      expect(result.terminalOutput).not.toContain("\u001B[3J");
      expect(result.terminalOutput).toContain("resolveRetries");
      expect(result.terminalOutput.indexOf("const retryLimit")).toBeLessThan(
        result.terminalOutput.indexOf("resolveRetries"),
      );
      const [panel] = mutationPanels(result.tuiRenderedOutput, "replace streaming.ts · ");
      expect(panel).toContain("retryLimit = 3");
      expect(panel).toContain("timeoutMs = 5_000");
      expect(panel).toMatch(/-\s+const transport = createTransport/u);
      expect(panel).not.toContain("▌");
    });
  });

  test("keeps the generated viewport after post-edit formatting", async () => {
    await withTempWorkspace(async (directory) => {
      const before = Array.from(
        { length: 30 },
        (_, index) => `const value${index + 1} = ${index + 1};`,
      ).join("\n");
      const file = await createFixture(directory, "post-edit-viewport.ts", before);
      const result = await runSingleMutation(directory, "replace", {
        path: "post-edit-viewport.ts",
        start: formatLineHashAnchor(20, "const value20 = 20;"),
        text: "const value20 = computeValue();",
      });
      const rendered = result.tuiRenderedOutput;
      const [panel] = mutationPanels(rendered, "replace post-edit-viewport.ts · ");

      await expect(readFile(file, "utf8")).resolves.toContain(
        "// formatted outside generated viewport",
      );
      expect(rendered).toMatch(/replace post-edit-viewport\.ts · (?:line 20|selected range)/u);
      expect(rendered).toContain("+0 ~2 -0");
      expect(panel).toContain("19 ~ const value19 = formattedContext();");
      expect(panel).toContain("20 ~ const value20 = computeValue();");
      expect(panel).not.toContain("formatted outside generated viewport");
      expect(panel).not.toContain("value17");
      expect(panel).not.toContain("value23");
    });
  });

  test("restores the semantic viewport from the persisted session", async () => {
    await withTempWorkspace(async (directory) => {
      const before = Array.from(
        { length: 30 },
        (_, index) => `const value${index + 1} = ${index + 1};`,
      ).join("\n");
      await createFixture(directory, "post-edit-viewport.ts", before);
      const firstRun = await runSingleMutation(directory, "replace", {
        path: "post-edit-viewport.ts",
        start: formatLineHashAnchor(20, "const value20 = 20;"),
        text: "const value20 = computeValue();",
      });
      const sessionData = await readSessionArtifact(firstRun.artifacts.run);
      const sessionFile = path.join(directory, "persisted-mutation-session.jsonl");
      await writeFile(sessionFile, sessionData, "utf8");
      const sessionEntries = sessionData
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as PersistedSessionEntry);
      const persistedResult = sessionEntries.find(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "toolResult" &&
          entry.message.toolName === "replace",
      );
      const fragments = persistedResult?.message?.details?.mutationRender;
      expect(fragments).toHaveLength(1);
      expect(fragments?.[0]?.model).toBeDefined();

      const piCommand = path.join(directory, "resume-pi-session");
      await writeFile(
        piCommand,
        `#!/usr/bin/env bash\nexec pi --session ${JSON.stringify(sessionFile)} "$@"\n`,
        "utf8",
      );
      await chmod(piCommand, 0o755);
      const resumed = await runInSeparatePi(() =>
        new PiIntegrationTest({
          testName: "text-editor-renderer-session-resumed",
          cwd: directory,
          extensions: extensions.paths.map((extension) =>
            extension === defaultTextEditorExtension ? rendererTestStand : extension,
          ),
          tools: ["replace", "read"],
          piCommand,
          rawMode: false,
          conversation: [assistantMessage([text("Session restored")])],
        }).run("Continue after restoring the session"),
      );
      const rendered = resumed.tuiRenderedOutput;
      const [panel] = mutationPanels(rendered, "replace post-edit-viewport.ts · ");

      expect(rendered).toMatch(/replace post-edit-viewport\.ts · (?:line 20|selected range)/u);
      expect(rendered).toContain("+0 ~2 -0");
      expect(panel).toContain("19 ~ const value19 = formattedContext();");
      expect(panel).toContain("20 ~ const value20 = computeValue();");
      expect(panel).not.toContain("formatted outside generated viewport");
      expect(rendered).not.toContain("post-edit-viewport.ts +2 -2");
    });
  });

  test("renders a realistic mixed TypeScript hunk with semantic stats", async () => {
    await withTempWorkspace(async (directory) => {
      const before = [
        'import { Service } from "./service.js";',
        "",
        "export interface ServiceOptions {",
        "    endpoint: string;",
        "    timeoutMs: number;",
        "    retries: number;",
        "    legacyMode: boolean;",
        "}",
        "",
        "export function createService(options: ServiceOptions): Service {",
        "    const transport = createTransport(options);",
        "    return new Service(transport);",
        "}",
      ].join("\n");
      const after = before
        .replace("    retries: number;", "    retryLimit: number;")
        .replace("    legacyMode: boolean;", "    trace?: boolean;");
      await createFixture(directory, "service.ts", before);
      const result = await runSingleMutation(directory, "write", {
        path: "service.ts",
        content: after,
      });
      const rendered = result.tuiRenderedOutput;
      const [panel] = mutationPanels(rendered, "write service.ts");

      expect(rendered).toMatch(/write service\.ts/u);
      expect(rendered).toContain("+1 ~1 -1");
      expect(panel).toMatch(/6\s+~\s+retryLimit: number;/u);
      expect(panel).toMatch(/7\s+-\s+legacyMode: boolean;/u);
      expect(panel).toMatch(/7\s+\+\s+trace\?: boolean;/u);
      expect(panel).not.toContain("retries: number;");
      expect(panel).toContain("endpoint: string;");
      expect(panel).toContain("timeoutMs: number;");
    });
  });

  test.each([
    {
      tool: "insert",
      arguments: {
        path: "subject.ts",
        anchor: formatLineHashAnchor(3, "    return value;"),
        text: "    audit(value);",
      },
      stats: "+1 ~0 -0",
      row: /4\s+\+\s+audit\(value\);/u,
    },
    {
      tool: "delete",
      arguments: {
        path: "subject.ts",
        start: formatLineHashAnchor(2, "    const value = load();"),
      },
      stats: "+0 ~0 -1",
      row: /2\s+-\s+const value = load\(\);/u,
    },
  ])(
    "renders a pure semantic row through $tool",
    async ({ tool, arguments: input, stats, row }) => {
      await withTempWorkspace(async (directory) => {
        await createFixture(
          directory,
          "subject.ts",
          "export function run() {\n    const value = load();\n    return value;\n}\n",
        );
        const result = await runSingleMutation(directory, tool, input);
        const rendered = result.tuiRenderedOutput;
        const [panel] = mutationPanels(rendered, `${tool} subject.ts · `);

        expect(rendered).toContain(stats);
        expect(panel).toMatch(row);
      });
    },
  );

  test("shows per-file stats for a copy with a target", async () => {
    await withTempWorkspace(async (directory) => {
      await createFixture(directory, "source.txt", "source-one\ncopy-me\nsource-end\n");
      await createFixture(directory, "target.txt", "target-start\ntarget-end\n");
      const result = await runCrossFileMutation(directory, "copy", "copy-me");
      const rendered = result.tuiRenderedOutput;
      const panel = mutationPanels(rendered, "copy source.txt · ");

      expect(rendered).toContain("copy source.txt · selected range -> target.txt · selected range");
      expect(rendered).toContain("+1 ~0 -0");
      expect(panel).toHaveLength(1);
      expect(panel[0]).not.toMatch(/source\.txt|target\.txt|\+\d+ ~\d+ -\d+/u);
    });
  });

  test("shows per-file stats for a move with a target", async () => {
    await withTempWorkspace(async (directory) => {
      await createFixture(directory, "source.txt", "source-one\nmove-me\nsource-end\n");
      await createFixture(directory, "target.txt", "target-start\ntarget-end\n");
      const result = await runCrossFileMutation(directory, "move", "move-me");
      const rendered = result.tuiRenderedOutput;
      const panels = mutationPanels(rendered, "move source.txt · ");

      expect(rendered).toContain("move source.txt · selected range -> target.txt · selected range");
      expect(rendered).toContain("+1 ~0 -1");
      expect(panels).toHaveLength(2);
      expect(panels.join("\n")).not.toMatch(/source\.txt|target\.txt|\+\d+ ~\d+ -\d+/u);
    });
  });

  test.each(["before content starts", "when arguments arrive together"])(
    "does not render a diff for an overwrite blocked $delivery",
    async (delivery) => {
      await withTempWorkspace(async (directory) => {
        await createFixture(directory, "blocked-overwrite.txt", "original content\n");
        const generated = Array.from(
          { length: 12 },
          (_, index) => `blocked line ${index + 1}`,
        ).join("\n");
        const argumentsJson = JSON.stringify({ path: "blocked-overwrite.txt", content: generated });
        const chunks =
          delivery === "before content starts"
            ? ['{"path":"blocked-overwrite.txt",', `"content":${JSON.stringify(generated)}}`]
            : [argumentsJson];
        const result = await new PiIntegrationTest({
          testName: `text-editor-renderer-blocked-overwrite-${delivery.replaceAll(" ", "-")}`,
          cwd: directory,
          extensions: [
            ...extensions.paths.map((extension) =>
              extension === defaultTextEditorExtension ? rendererTestStand : extension,
            ),
            overwriteGuardExtension,
          ],
          tools: ["write"],
          rawMode: false,
          conversation: [
            assistantMessage(
              [
                toolCall({
                  id: "blocked-overwrite",
                  name: "write",
                  argumentsJson,
                  chunks: { kind: "explicit", chunks },
                  delayMs: 40,
                }),
              ],
              { stopReason: "toolUse" },
            ),
            assistantMessage([text("Done")]),
          ],
        }).run("Try to overwrite the file");

        expect(getToolResultText(result, "blocked-overwrite")).toContain(
          "Reason: The file already exists",
        );
        expect(result.tuiRenderedOutput).toContain("← ⊘ Overwrite Blocked");
        expect(result.tuiRenderedOutput).not.toContain("Reason: The file already exists");
        expect(result.tuiRenderedOutput).not.toMatch(/╭─{40,}╮/u);
        expect(result.terminalOutput).not.toContain("original content");
      });
    },
  );

  test("does not retain a diff after a stale-anchor block", async () => {
    await withTempWorkspace(async (directory) => {
      await createFixture(directory, "blocked-stale.txt", "alpha\nbeta\n");
      const result = await new PiIntegrationTest({
        testName: "text-editor-renderer-blocked-stale-anchor",
        cwd: directory,
        extensions: [
          ...extensions.paths.map((extension) =>
            extension === defaultTextEditorExtension ? rendererTestStand : extension,
          ),
          staleAnchorGuardExtension,
        ],
        tools: ["insert"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "blocked-stale-anchor",
                name: "insert",
                arguments: {
                  path: "blocked-stale.txt",
                  anchor: "1#AAAA",
                  text: "content that must never be rendered",
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Try to insert with a stale anchor");

      expect(getToolResultText(result, "blocked-stale-anchor")).toContain("is stale");
      expect(result.tuiRenderedOutput).toContain("← ⚠ Stale Anchor");
      expect(result.tuiRenderedOutput).not.toContain("[SYSTEM] insert blocked");
      expect(result.tuiRenderedOutput).not.toContain("regenerate the anchor");
      expect(result.tuiRenderedOutput).not.toMatch(/╭─{40,}╮/u);
      expect(result.terminalOutput).not.toContain("content that must never be rendered");
    });
  });
});

async function runSingleMutation(
  directory: string,
  tool: string,
  arguments_: Readonly<Record<string, unknown>>,
) {
  return new PiIntegrationTest({
    testName: `text-editor-renderer-${tool}`,
    cwd: directory,
    extensions: extensions.paths.map((extension) =>
      extension === defaultTextEditorExtension ? rendererTestStand : extension,
    ),
    tools: [tool, "read"],
    rawMode: false,
    conversation: [
      assistantMessage(
        [toolCall({ id: `${tool}-semantic-renderer`, name: tool, arguments: arguments_ })],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Done")]),
    ],
  }).run(`${tool} the requested content`);
}

async function runCrossFileMutation(
  directory: string,
  tool: "copy" | "move",
  selectedText: string,
) {
  return new PiIntegrationTest({
    testName: `text-editor-renderer-${tool}-target`,
    cwd: directory,
    extensions: extensions.paths.map((extension) =>
      extension === defaultTextEditorExtension ? rendererTestStand : extension,
    ),
    tools: [tool, "read"],
    rawMode: false,
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: `${tool}-target`,
            name: tool,
            arguments: {
              path: "source.txt",
              start: formatLineHashAnchor(2, selectedText),
              target: "target.txt",
              targetStart: formatLineHashAnchor(1, "target-start"),
            },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Done")]),
    ],
  }).run(`${tool} the requested line to the target`);
}

async function readSessionArtifact(runFile: string): Promise<string> {
  const records = (await readFile(runFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly kind?: unknown; readonly data?: unknown });
  const session = records.find(({ kind, data }) => kind === "session" && typeof data === "string");

  if (typeof session?.data !== "string") {
    throw new Error("Expected the run artifact to contain a persisted session");
  }

  return session.data;
}

async function runInSeparatePi<T>(run: () => Promise<T>): Promise<T> {
  const runner = process.env.PI_INTEGRATION_TEST_RUNNER;
  delete process.env.PI_INTEGRATION_TEST_RUNNER;

  try {
    return await run();
  } finally {
    if (runner !== undefined) {
      process.env.PI_INTEGRATION_TEST_RUNNER = runner;
    }
  }
}

function mutationPanels(rendered: string, header: string): readonly string[] {
  const mutation = rendered.slice(rendered.indexOf(header));
  return mutation.match(/╭─{40,}╮[\s\S]*?╰─{40,}╯/gu) ?? [];
}

function largeWriteContent(lineCount: number): string {
  return (
    Array.from(
      { length: lineCount },
      (_, index) =>
        `row ${String(index + 1).padStart(4, "0")} | é | 👩‍💻 | payload ${String(index + 1).padStart(4, "0")}`,
    ).join("\n") + "\n"
  );
}

interface ReplayedFrame {
  readonly frame: number;
  readonly streamOffset: number;
  readonly text: string;
}

interface LargeWriteQuiescenceInput {
  readonly mode: string;
  readonly lineCount: number;
  readonly frames: readonly ReplayedFrame[];
  readonly finalScreen: string;
  readonly capturedScreen: string;
  readonly frameDelaysMs: readonly number[];
  readonly traceEvents: readonly {
    readonly type: string;
    readonly sequence: number;
    readonly timestamp: number;
    readonly event?: { readonly toolCallId?: string };
  }[];
  readonly state: { readonly isIdle: boolean; readonly hasPendingMessages: boolean } | undefined;
  readonly expectSuccessor?: boolean;
}

function rendererObservationWindowMs(): number {
  // A later streamed tool call must force the previous mutation panel to settle promptly.
  return 4_000;
}

async function replaySynchronizedFrames(
  runPath: string,
  frameDelaysMs: readonly number[],
): Promise<{ readonly frames: readonly ReplayedFrame[]; readonly finalScreen: string }> {
  if (frameDelaysMs.length === 0 || frameDelaysMs.length > 1_000) {
    throw new Error(
      `Expected between 1 and 1000 synchronized frames, received ${frameDelaysMs.length}`,
    );
  }

  const outputDirectory = path.join(path.dirname(runPath), "replay");
  await runFile(
    piTestCommand,
    ["replay", runPath, "--output", outputDirectory, "--frames", `1-${frameDelaysMs.length}`],
    { maxBuffer: 4 * 1024 * 1024 },
  );

  const indexLines = (await readFile(path.join(outputDirectory, "index.tsv"), "utf8"))
    .trim()
    .split("\n")
    .slice(1);
  if (indexLines.length !== frameDelaysMs.length) {
    throw new Error(
      `Replay indexed ${indexLines.length} frames but the run recorded ${frameDelaysMs.length}`,
    );
  }

  const frames = await Promise.all(
    indexLines.map(async (line) => {
      const [frameText, streamOffsetText] = line.split("\t", 3);
      const frame = Number(frameText);
      const streamOffset = Number(streamOffsetText);
      if (!Number.isSafeInteger(frame) || !Number.isSafeInteger(streamOffset)) {
        throw new Error(`Invalid replay index row: ${line}`);
      }

      const framePath = path.join(outputDirectory, `frame-${String(frame).padStart(6, "0")}.txt`);
      return { frame, streamOffset, text: await readFile(framePath, "utf8") };
    }),
  );

  return {
    frames,
    finalScreen: await readFile(path.join(outputDirectory, "final.txt"), "utf8"),
  };
}

function verifyLargeWriteQuiescence(input: LargeWriteQuiescenceInput) {
  const quiescentFrame = input.frames.at(-1);
  if (quiescentFrame === undefined) {
    throw new Error("No synchronized frame was captured");
  }
  if (input.finalScreen !== input.capturedScreen) {
    throw new Error("The replay final screen and captured screen disagree");
  }
  if (input.finalScreen.includes("▌")) {
    throw new Error("Found a typing cursor after the observation window");
  }
  if (largeWriteMutationPanel(quiescentFrame.text) !== largeWriteMutationPanel(input.finalScreen)) {
    throw new Error("The final synchronized frame and captured mutation panel disagree");
  }

  const finalRow = `row ${String(input.lineCount).padStart(4, "0")}`;
  if (
    !input.finalScreen.includes("write large-write.txt") ||
    !input.finalScreen.includes(`+${input.lineCount} ~0 -0`) ||
    !input.finalScreen.includes(finalRow)
  ) {
    throw new Error("The quiescent frame does not contain the complete successful write");
  }
  if (input.mode === "expanded" && !input.finalScreen.includes("row 0001")) {
    throw new Error("The expanded quiescent frame lost the first row");
  }
  if (
    input.mode === "compact" &&
    input.lineCount > 1 &&
    !input.finalScreen.includes("lines omitted")
  ) {
    throw new Error("The compact quiescent frame lost its viewport omission marker");
  }
  const visualCatchUpMs = input.expectSuccessor
    ? verifySuccessorCatchUp(input, finalRow)
    : undefined;

  const progressFrames = input.frames
    .slice(0, -1)
    .filter(({ text: frameText }) => frameText.includes("▌") && frameText.includes("row "));
  if (input.lineCount > 1 && progressFrames.length === 0) {
    throw new Error("No synchronized typing frame was captured before quiescence");
  }

  const progressRows = progressFrames
    .map(({ text: frameText }) => maximumVisibleRow(frameText))
    .filter((row) => row > 0);
  if (
    input.lineCount > 1 &&
    (progressRows.length < 2 || Math.max(...progressRows) <= Math.min(...progressRows))
  ) {
    throw new Error("Synchronized typing frames did not advance through the write");
  }

  const toolExecutionEnd = input.traceEvents.find(
    (event) =>
      event.type === "tool_execution_end" &&
      event.event?.toolCallId === `large-write-${input.mode}-${input.lineCount}`,
  );
  const agentSettled = [...input.traceEvents]
    .reverse()
    .find((event) => event.type === "agent_settled");
  if (
    toolExecutionEnd === undefined ||
    agentSettled === undefined ||
    toolExecutionEnd.sequence >= agentSettled.sequence ||
    toolExecutionEnd.timestamp > agentSettled.timestamp
  ) {
    throw new Error("Trace order does not show tool completion before agent settlement");
  }
  if (input.state?.isIdle !== true || input.state.hasPendingMessages) {
    throw new Error("Pi did not settle without pending messages");
  }

  const evidenceFrames = [progressFrames[0], progressFrames.at(-1), quiescentFrame]
    .filter((frame): frame is ReplayedFrame => frame !== undefined)
    .filter(
      (frame, index, frames) =>
        frames.findIndex(({ frame: value }) => value === frame.frame) === index,
    )
    .map((frame) => ({
      frame: frame.frame,
      streamOffset: frame.streamOffset,
      elapsedMs: input.frameDelaysMs.slice(0, frame.frame).reduce((sum, delay) => sum + delay, 0),
      kind: frame.frame === quiescentFrame.frame ? "quiescent" : "progress",
    }));

  return {
    trace: {
      toolExecutionEnd: {
        sequence: toolExecutionEnd.sequence,
        timestamp: toolExecutionEnd.timestamp,
      },
      agentSettled: { sequence: agentSettled.sequence, timestamp: agentSettled.timestamp },
    },
    frames: evidenceFrames,
    quiescentFrame: quiescentFrame.frame,
    visualCatchUpMs,
    captureTimestamp: Date.now(),
  };
}

function verifySuccessorCatchUp(input: LargeWriteQuiescenceInput, finalRow: string): number {
  const successorFrameIndex = input.frames.findIndex(({ text: frameText }) =>
    frameText.includes("stream-ahead.txt"),
  );
  if (successorFrameIndex < 0) {
    throw new Error("No synchronized frame showed the later tool call");
  }
  const settledAfterSuccessor = input.frames
    .slice(successorFrameIndex)
    .find(({ text: frameText }) => {
      const mutationPanel = largeWriteMutationPanel(frameText);
      return !mutationPanel.includes("▌") && mutationPanel.includes(finalRow);
    });
  if (settledAfterSuccessor === undefined) {
    throw new Error("The mutation animation did not settle after the later tool call appeared");
  }
  const successorFrame = input.frames[successorFrameIndex];
  const visualCatchUpMs = input.frameDelaysMs
    .slice(successorFrame.frame, settledAfterSuccessor.frame)
    .reduce((sum, delay) => sum + delay, 0);
  if (visualCatchUpMs > 2_000) {
    throw new Error(`Mutation playback lagged the later tool call by ${visualCatchUpMs}ms`);
  }
  return visualCatchUpMs;
}

function largeWriteMutationPanel(screen: string): string {
  const start = screen.indexOf("write large-write.txt");
  const end = screen.indexOf("╯", start);
  if (start < 0 || end < 0) {
    throw new Error("The screen does not contain a complete large-write mutation panel");
  }
  return screen.slice(start, end + 1);
}

function maximumVisibleRow(frame: string): number {
  return Math.max(0, ...[...frame.matchAll(/row (\d{4})/gu)].map((match) => Number(match[1])));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe("exact anchor header rendering", () => {
  test("uses a semantic compact label for a multiline exact anchor", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(
        directory,
        "service.txt",
        [
          "alpha",
          "function buildService() {",
          "  const endpoint = resolveEndpoint();",
          "  return endpoint;",
          "}",
          "omega",
        ].join("\n") + "\n",
      );
      const result = await new PiIntegrationTest({
        testName: "text-editor-renderer-exact-multiline-header",
        cwd: directory,
        extensions: extensions.paths.map((extension) =>
          extension === defaultTextEditorExtension ? rendererTestStand : extension,
        ),
        tools: ["replace"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "replace-exact-multiline",
                name: "replace",
                arguments: {
                  path: "service.txt",
                  start:
                    "function buildService() {\n  const endpoint = resolveEndpoint();\n  return endpoint;\n}",
                  text: "function buildService() {\n  return resolveEndpoint();\n}",
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Replace the selected function");

      const rendered = result.tuiRenderedOutput;
      expect(getToolExecution(result, "replace-exact-multiline").isError).toBe(false);
      expect(rendered).toContain("replace service.txt · selected text");
      expect(rendered).not.toContain("replace service.txt · function buildService()");
      await expect(readFile(file, "utf8")).resolves.toContain("return resolveEndpoint");
    });
  });

  test("keeps ambiguous-anchor recovery details agent-facing", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(directory, "ambiguous.txt", "same\nsame\n");
      const result = await new PiIntegrationTest({
        testName: "text-editor-renderer-ambiguous-anchor-failure",
        cwd: directory,
        extensions: extensions.paths.map((extension) =>
          extension === defaultTextEditorExtension ? rendererTestStand : extension,
        ),
        tools: ["replace"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "replace-ambiguous",
                name: "replace",
                arguments: { path: "ambiguous.txt", start: "same", text: "changed" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Try the replacement and recover if the selection is ambiguous");

      const agentResult = getToolResultText(result, "replace-ambiguous");
      const rendered = result.tuiRenderedOutput;
      const mutationOutput = rendered.slice(
        rendered.indexOf("replace ambiguous.txt"),
        rendered.indexOf("POSTFLIGHT STARTED"),
      );
      expect(getToolExecution(result, "replace-ambiguous").isError).toBe(true);
      expect(agentResult).toContain('replace blocked: start anchor "same" is ambiguous');
      expect(agentResult).toMatch(/\d+#[A-F0-9]{4}\|/u);
      expect(mutationOutput).toContain("Not changed · selection is ambiguous");
      expect(mutationOutput).not.toContain("[SYSTEM]");
      expect(mutationOutput).not.toContain("Use a unique text span");
      expect(mutationOutput).not.toMatch(/\d+#[A-F0-9]{4}\|/u);
      expect(mutationOutput.match(/selection is ambiguous/gu)).toHaveLength(1);
      await expect(readFile(file, "utf8")).resolves.toBe("same\nsame\n");
    });
  });
});
