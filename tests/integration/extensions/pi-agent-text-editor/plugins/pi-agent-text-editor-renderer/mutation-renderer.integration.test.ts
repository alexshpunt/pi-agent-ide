import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
      readonly results?: readonly {
        readonly data?: { readonly rawChanges?: readonly unknown[] };
      }[];
    };
  };
}

describe("text mutation renderer", () => {
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
      const panelStart = rendered.indexOf("╭─", rendered.indexOf("replace stable.txt:"));
      const panelEnd = rendered.indexOf("╯", panelStart);
      const panel = rendered.slice(panelStart, panelEnd + 1);
      expect(rendered).toMatch(/replace stable\.txt:\S+\s+\+0 ~1 -0/u);
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
      expect(mutationPanels(rendered, "replace inherited-path.ts:")).toHaveLength(2);
    });
  });

  test("keeps one final viewport for every batched mutation call", async () => {
    await withTempWorkspace(async (directory) => {
      const source = Array.from(
        { length: 32 },
        (_, index) => `const value${index + 1} = ${index + 1};`,
      ).join("\n");
      await createFixture(directory, "batched-viewports.ts", source);
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
                  path: "batched-viewports.ts",
                  start: formatLineHashAnchor(7, "const value7 = 7;"),
                  text: "const value7 = loadPrimaryValue();",
                },
              }),
              toolCall({
                id: "replace-second-viewport",
                name: "replace",
                arguments: {
                  path: "batched-viewports.ts",
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
      const panels = mutationPanels(rendered, "replace batched-viewports.ts:");

      expect(rendered.match(/replace batched-viewports\.ts:\S+\s+\+0 ~1 -0/gu)).toHaveLength(2);
      expect(panels).toHaveLength(2);
      expect(panels[0]).toContain("loadPrimaryValue");
      expect(panels[0]).not.toContain("loadSecondaryValue");
      expect(panels[1]).toContain("loadSecondaryValue");
      expect(panels[1]).not.toContain("loadPrimaryValue");
      expect(rendered).not.toContain("full diff is in the last successful tool call");
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
      expect(result.terminalOutput).toContain("resolveRetries");
      expect(result.terminalOutput.indexOf("const retryLimit")).toBeLessThan(
        result.terminalOutput.indexOf("resolveRetries"),
      );
      const [panel] = mutationPanels(result.tuiRenderedOutput, "replace streaming.ts:");
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
      const [panel] = mutationPanels(rendered, "replace post-edit-viewport.ts:");

      await expect(readFile(file, "utf8")).resolves.toContain(
        "// formatted outside generated viewport",
      );
      expect(rendered).toMatch(/replace post-edit-viewport\.ts:\S+\s+\+0 ~2 -0/u);
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
      const rawChanges = persistedResult?.message?.details?.results?.[0]?.data?.rawChanges;

      expect(rawChanges).toHaveLength(1);

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
      const [panel] = mutationPanels(rendered, "replace post-edit-viewport.ts:");

      expect(rendered).toMatch(/replace post-edit-viewport\.ts:\S+\s+\+0 ~2 -0/u);
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

      expect(rendered).toMatch(/write service\.ts\s+\+1 ~1 -1/u);
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
        const [panel] = mutationPanels(rendered, `${tool} subject.ts:`);

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
      const panel = mutationPanels(rendered, "copy source.txt:");

      expect(rendered).toMatch(
        /copy source\.txt:\S+\s+\+0 ~0 -0\s+->\s+target\.txt:\S+\s+\+1 ~0 -0/u,
      );
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
      const panels = mutationPanels(rendered, "move source.txt:");

      expect(rendered).toMatch(
        /move source\.txt:\S+\s+\+0 ~0 -1\s+->\s+target\.txt:\S+\s+\+1 ~0 -0/u,
      );
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
