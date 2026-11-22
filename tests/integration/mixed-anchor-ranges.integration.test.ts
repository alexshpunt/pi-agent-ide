import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getProviderSystemPrompt,
  getToolExecution,
  getToolExecutionDetails,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { expect, test } from "vitest";
import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.ts";

const original =
  "HEADER\nleft START suffix\nmiddle\nprefix END suffix\nGAP\nprefix DEST suffix\nTAIL\n";
const selected = "left START suffix\nmiddle\nprefix END suffix\n";
const anchor = "SEARCH#RUNTIME:1:1:line";
const destination = "SEARCH#RUNTIME:2:1:line";
const root = path.resolve(".agents/tmp/mixed-anchor-ranges");
const marker = "serializes checkout‑payload 0042";
const prefix = "// unchanged\n".repeat(19);
const largeBlock = `// BEGIN ${marker}\n${"sample();\n".repeat(1000)}// END ${marker}\n`;
const large = `${prefix}${largeBlock}// SUFFIX\n`;
const cases: {
  name: string;
  args: Record<string, unknown>;
  expected: string;
  error?: boolean;
  input?: string;
  offset?: number;
  readLimit?: number;
  destinationQuery?: string;
  ast?: boolean;
}[] = [
  {
    name: "move",
    args: { from: "SCOPE#RUNTIME:1", through: anchor, targetAfter: destination },
    input: "function example() {\n  work();\n  more();\n  finish();\n}\n// END\n// DEST\n",
    offset: 1,
    ast: true,
    expected: "// DEST\nfunction example() {\n  work();\n  more();\n  finish();\n}\n// END\n",
  },
  {
    name: "move",
    args: { from: "LINE#RUNTIME:1", through: anchor, targetAfter: destination },
    input: large,
    offset: 20,
    destinationQuery: "SUFFIX",
    readLimit: largeBlock.split("\n").length - 1,
    expected: `${prefix}// SUFFIX\n${largeBlock}`,
  },
  {
    name: "replace",
    args: { from: anchor, through: "GAP\n", text: "NEW\n" },
    expected: original.replace("prefix END suffix\nGAP\n", "NEW\n"),
  },
  {
    name: "copy",
    // Copied whole lines carry their content; the target's final line break stays outside the span.
    args: {
      from: "LINE#RUNTIME:1",
      through: anchor,
      targetFrom: destination,
      targetThrough: "TAIL",
    },
    expected: original.replace("prefix DEST suffix\nTAIL\n", selected),
  },
  {
    name: "move",
    args: {
      from: "LINE#RUNTIME:1",
      through: anchor,
      targetFrom: "TAIL",
      targetThrough: destination,
    },
    expected: original,
    error: true,
  },
  {
    name: "replace",
    args: { from: "ZZZZZZZ", through: anchor, text: "BAD" },
    expected: original,
    error: true,
  },
  { name: "delete", args: { from: "prefix", through: anchor }, expected: original, error: true },
  {
    name: "replace",
    // The span covers whole lines; the text replaces them and the last LF stays.
    args: { from: "LINE#RUNTIME:1", through: anchor, text: "NEW\n" },
    expected: original.replace(selected, "NEW\n"),
  },
  {
    name: "delete",
    args: { from: "LINE#RUNTIME:1", through: anchor },
    expected: original.replace(selected, ""),
  },
  {
    name: "copy",
    args: { from: "LINE#RUNTIME:1", through: anchor, targetAfter: destination },
    expected: original.replace("TAIL", selected + "TAIL"),
  },
  {
    name: "move",
    args: { from: "LINE#RUNTIME:1", through: anchor, targetAfter: destination },
    expected: original.replace(selected, "").replace("TAIL", selected + "TAIL"),
  },
  {
    name: "insert",
    args: { after: anchor, text: "NEW\n" },
    expected: original.replace("GAP", "NEW\nGAP"),
  },
  {
    name: "insert",
    args: { before: anchor, text: "NEW\n" },
    expected: original.replace("prefix END", "NEW\nprefix END"),
  },
  {
    name: "copy",
    args: {
      from: "LINE#RUNTIME:1",
      through: anchor,
      targetFrom: destination,
      targetThrough: "TAIL",
    },
    expected: original.replace("prefix DEST suffix\nTAIL\n", selected),
  },
  {
    name: "replace",
    args: { at: "SEARCH#RUNTIME:1:1:match", text: "NEW" },
    expected: original.replace("END", "NEW"),
  },
  {
    name: "delete",
    args: { from: anchor, through: "LINE#RUNTIME:1" },
    expected: original,
    error: true,
  },
  {
    name: "move",
    args: { from: "LINE#RUNTIME:1", through: anchor, targetAfter: destination },
    input: large,
    offset: 20,
    destinationQuery: "SUFFIX",
    expected: large,
    error: true,
  },
];

for (const [index, scenario] of cases.entries()) {
  test(`mixed boundary ${index}: ${scenario.name}`, async () => {
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    try {
      await writeFile(path.join(cwd, "fixture.ts"), scenario.input ?? original);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ noAnimations: true, noPostProcessing: true }),
      );
      const call = (id: string, name: string, args: Record<string, unknown>) =>
        assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
      const result = await new PiIntegrationTest({
        testName: `mixed-boundary-${index}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        // Start Pi in the fixture workspace so it loads the post-processing setting.
        transport: "rpc",
        extensions: [
          path.resolve(
            "tests/integration/extensions/pi-agent-text-editor/support/search-anchor-runtime-extension.ts",
          ),
          // Typed source placeholders need the direct runtime: the composite
          // interceptor resolves source paths before the tool_call test hook.
          ...(index === 2 || index === 3
            ? createExtensionSet().paths
            : [path.resolve("src/pi-agent-ide.ts")]),
        ],
        tools: ["read", "search", scenario.name],
        conversation: [
          call("read", "read", {
            path: "fixture.ts",
            offset: scenario.offset ?? 2,
            limit: scenario.readLimit ?? 1,
            views: scenario.ast ? ["anchors", "ast"] : ["anchors"],
          }),
          call("end", "search", { path: "fixture.ts", query: "END" }),
          call("destination", "search", {
            path: "fixture.ts",
            query: scenario.destinationQuery ?? "DEST",
          }),
          call("mutation", scenario.name, { path: "fixture.ts", ...scenario.args }),
          assistantMessage([text("Done")]),
        ],
      }).run("Execute the requested text operation using the supplied boundary types.");
      expect(getToolExecution(result, "mutation").isError).toBe(scenario.error ?? false);

      if (!scenario.error) {
        expect(getToolExecutionDetails(getToolExecution(result, "mutation"))).toMatchObject({
          results: [
            {
              data: {
                operations: [{ operation: scenario.name }],
                formatting: { status: index === 2 || index === 3 ? "not-reported" : "disabled" },
              },
            },
          ],
        });
      }
      expect(await readFile(path.join(cwd, "fixture.ts"), "utf8")).toBe(scenario.expected);
      if (index === 0)
        await writeFile(path.join(root, "system-prompt.txt"), getProviderSystemPrompt(result));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 120_000);
}
