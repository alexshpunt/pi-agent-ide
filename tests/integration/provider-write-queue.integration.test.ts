import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutions,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

test.each([
  {
    name: "comment creation",
    tool: "write",
    code: `const results = await Promise.all(["first", "second", "third"].map(content => tools.write({path:"fixture://queue/issue/comments/new", content}))); if (!results.every(result => result?.effect === "applied")) throw new Error(JSON.stringify(results));`,
    file: "provider-comments.txt",
    expected: "first\nsecond\nthird\n",
    count: 3,
  },
  {
    name: "body replacement",
    tool: "replace",
    code: `await Promise.all(["apple", "pear"].map(name => tools.replace({path:"fixture://queue/pull#body", at:"old " + name, text:"new " + name}))); `,
    file: "provider-body.txt",
    expected: "new apple\nnew pear\n",
    count: 2,
  },
])(
  "parallel provider $name waits for the earlier write and applies once",
  async ({ name, tool, code, file, expected, count }) => {
    await withTempWorkspace(async (cwd) => {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/settings.json"),
        JSON.stringify({ codemode: { mode: "on" } }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
      );
      await writeFile(path.join(cwd, "provider-body.txt"), "old apple\nold pear\n");
      const result = await new PiIntegrationTest({
        testName: name,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          path.resolve("tests/integration/fixtures/slow-provider-writes.ts"),
        ],
        tools: [tool, "codemode"],
        conversation: [
          assistantMessage(
            [toolCall({ id: "pending-provider-writes", name: "codemode", arguments: { code } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Run the provider mutations together.");
      expect.soft(getToolExecution(result, "pending-provider-writes").isError).toBe(false);
      const calls = getToolExecutions(result).filter(({ toolName }) => toolName === tool);
      expect
        .soft(calls.map(({ isError }) => isError))
        .toEqual(Array.from({ length: count }, () => false));
      expect(await readFile(path.join(cwd, file), "utf8")).toBe(expected);
    });
  },
);
