import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import {
  PiIntegrationTest,
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { expect, test } from "vitest";

const available = (command: string, argument: string) =>
  spawnSync(command, [argument], { stdio: "ignore" }).status === 0;

interface Hit {
  readonly lineNumber: number;
  readonly matchedText: string;
  readonly role: string;
}

const files = {
  "go.mod": "module example.com/fields\n\ngo 1.24\n",
  "target.go": [
    "package fields",
    "",
    "type Holder struct { LongDisplacedDeclarationInTargetCap int }",
    "",
    "type First struct {",
    "\tShared int",
    "}",
    "",
    "type Second struct {",
    "\tShared int",
    "}",
    "",
  ].join("\n"),
};

async function search(queries: readonly string[]) {
  return withTempWorkspace(async (cwd) => {
    for (const [source, content] of Object.entries(files)) {
      const file = path.join(cwd, source);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    const run = await new PiIntegrationTest({
      testName: "workspace-go-struct-fields",
      cwd,
      isolateUserResources: true,
      artifactsDir: testArtifactsDir(import.meta.filename),
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["lsp_search"],
      environment: { PI_AGENT_IDE_LSP_LINGER_MS: "0" },
      rawMode: false,
      timeoutMs: 120_000,
      conversation: [
        ...queries.map((query, index) =>
          assistantMessage(
            [
              toolCall({
                id: `search-${index}`,
                name: "lsp_search",
                arguments: { query, path: "target.go" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Find the declarations in the target file.");
    return queries.map((query, index) => {
      const id = `search-${index}`;
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
      const { payload } = getToolExecutionDetails(getToolExecution(run, id)) as {
        payload: { complete: boolean; hits: readonly Hit[]; skipped?: unknown };
      };
      return {
        query,
        complete: payload.complete,
        skipped: payload.skipped,
        definitions: payload.hits
          .filter(({ role }) => role === "definition")
          .map(({ lineNumber, matchedText }) => ({ lineNumber, matchedText })),
      };
    });
  });
}

test.runIf(available("gopls", "version") && available("go", "version"))(
  "lists a Go struct field once as a complete result, also under two struct types and for a fuzzy query",
  async () => {
    const found = await search(["LongDisplacedDeclarationInTargetCap", "Shared", "shrd"]);
    expect(found).toEqual([
      {
        query: "LongDisplacedDeclarationInTargetCap",
        complete: true,
        skipped: undefined,
        definitions: [{ lineNumber: 3, matchedText: "LongDisplacedDeclarationInTargetCap" }],
      },
      {
        query: "Shared",
        complete: true,
        skipped: undefined,
        definitions: [
          { lineNumber: 6, matchedText: "Shared" },
          { lineNumber: 10, matchedText: "Shared" },
        ],
      },
      {
        // gopls matches the letters against `fields.Holder.LongDisplaced…` as well, and names it
        // with its package.
        query: "shrd",
        complete: true,
        skipped: undefined,
        definitions: [
          { lineNumber: 3, matchedText: "LongDisplacedDeclarationInTargetCap" },
          { lineNumber: 6, matchedText: "Shared" },
          { lineNumber: 10, matchedText: "Shared" },
        ],
      },
    ]);
  },
  150_000,
);
