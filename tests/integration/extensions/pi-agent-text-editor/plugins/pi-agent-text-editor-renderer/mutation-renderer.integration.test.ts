import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.ts";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "#integration/support/pi-runtime/pi-coding-agent-test.ts";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import {
  expectToolRowsPreserveBackground,
  toolBackgroundTheme,
} from "#integration/support/tui-background.ts";

/** The anchor of a line that occurs once in its file: it names the line's text alone. */
const uniqueLineAnchor = (lineText: string): string => formatLineHashAnchor(lineText, 1);

const extensions = createExtensionSet();
const defaultTextEditorExtension = path.resolve(
  process.cwd(),
  "tests/integration/extensions/pi-agent-text-editor/register-extension.ts",
);
const rendererTestStand = path.resolve(import.meta.dirname, "register-extension.ts");
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

describe("text mutation renderer", () => {
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
        extensions: [
          toolBackgroundTheme,
          ...extensions.paths.map((extension) =>
            extension === defaultTextEditorExtension ? rendererTestStand : extension,
          ),
        ],
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

  test("streams a diff for a mutation with an inherited path", async () => {
    await withTempWorkspace(async (directory) => {
      const source = Array.from(
        { length: 24 },
        (_, index) => `const value${index + 1} = ${index + 1};`,
      ).join("\n");
      await createFixture(directory, "inherited-path.ts", source);
      const result = await new PiIntegrationTest({
        testName: "text-editor-renderer-inherited-path-streaming",
        // Both completed panels and postflight output must fit in the final viewport.
        tuiSize: { cols: 160, rows: 100 },
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
                  start: uniqueLineAnchor("const value4 = 4;"),
                  text: "const value4 = loadPrimaryValue();",
                },
                delayMs: 0,
              }),
              toolCall({
                id: "replace-inherited-second",
                name: "replace",
                arguments: {
                  start: uniqueLineAnchor("const value18 = 18;"),
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
        tuiSize: { cols: 160, rows: 100 },
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
                  start: uniqueLineAnchor("const value7 = 7;"),
                  text: "const value7 = loadPrimaryValue();",
                },
              }),
              toolCall({
                id: "replace-second-viewport",
                name: "replace",
                arguments: {
                  path: "post-edit-viewport.ts",
                  start: uniqueLineAnchor("const value25 = 25;"),
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

      expect(
        rendered.match(/replace post-edit-viewport\.ts · (?:line \d+|[0-9A-HJKMNP-TV-Z]{7})/gu),
      ).toHaveLength(2);
      expect(rendered.match(/\+0 ~1 -0/gu)).toHaveLength(2);
      expect(panels).toHaveLength(2);
      expect(panels[0]).toContain("loadPrimaryValue");
      expect(panels[0]).not.toContain("loadSecondaryValue");
      expect(panels[1]).toContain("loadSecondaryValue");
      expect(panels[1]).not.toContain("loadPrimaryValue");
      expect(finalContent).toContain("loadPrimaryValue");
      expect(finalContent).toContain("loadSecondaryValue");
      expect(finalContent).toContain("formatted outside generated viewport");

      const earlier = getToolResultText(result, "replace-first-viewport");
      expect(earlier).not.toContain("formattedContext");
      expect(rendered).not.toContain(earlier.trim());
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
        start: uniqueLineAnchor("    const retries = resolveRetries();"),
        end: uniqueLineAnchor("    const service = new Service(transport);"),
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
        start: uniqueLineAnchor("const value20 = 20;"),
        text: "const value20 = computeValue();",
      });
      const rendered = result.tuiRenderedOutput;
      const [panel] = mutationPanels(rendered, "replace post-edit-viewport.ts · ");

      await expect(readFile(file, "utf8")).resolves.toContain(
        "// formatted outside generated viewport",
      );
      expect(rendered).toMatch(
        /replace post-edit-viewport\.ts · (?:line 20|[0-9A-HJKMNP-TV-Z]{7})/u,
      );
      expect(rendered).toContain("+0 ~2 -0");
      expect(panel).toContain("19 ~ const value19 = formattedContext();");
      expect(panel).toContain("20 ~ const value20 = computeValue();");
      expect(panel).not.toContain("formatted outside generated viewport");
      expect(panel).toContain("17   const value17 = 17;");
      expect(panel).not.toContain("value16");
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
        start: uniqueLineAnchor("const value20 = 20;"),
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

      expect(rendered).toMatch(
        /replace post-edit-viewport\.ts · (?:line 20|[0-9A-HJKMNP-TV-Z]{7})/u,
      );
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
        anchor: uniqueLineAnchor("    return value;"),
        text: "    audit(value);",
      },
      stats: "+1 ~0 -0",
      row: /4\s+\+\s+audit\(value\);/u,
    },
    {
      tool: "delete",
      arguments: {
        path: "subject.ts",
        start: uniqueLineAnchor("    const value = load();"),
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

      expect(rendered).toMatch(
        /copy source\.txt · (?:line \d+|[0-9A-HJKMNP-TV-Z]{7}) -> target\.txt · (?:line \d+|[0-9A-HJKMNP-TV-Z]{7})/u,
      );
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

      expect(rendered).toMatch(
        /move source\.txt · (?:line \d+|[0-9A-HJKMNP-TV-Z]{7}) -> target\.txt · (?:line \d+|[0-9A-HJKMNP-TV-Z]{7})/u,
      );
      expect(rendered).toContain("+1 ~0 -1");
      expect(panels).toHaveLength(2);
      expect(panels.join("\n")).not.toMatch(/source\.txt|target\.txt|\+\d+ ~\d+ -\d+/u);
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
              start: uniqueLineAnchor(selectedText),
              target: "target.txt",
              targetStart: uniqueLineAnchor("target-start"),
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
      expect(rendered).toContain("replace service.txt · function buildService()");
      await expect(readFile(file, "utf8")).resolves.toContain("return resolveEndpoint");
    });
  });
});
