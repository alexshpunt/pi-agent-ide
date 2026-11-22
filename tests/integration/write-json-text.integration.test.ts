import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

// Text a JSON round trip would change: `1.0`, spacing, key order and escaped quotes.
const object = '{"b": 1.0, "a": [true, null, {"q": "say \\"hi\\""}]}\n';
const array = '[ {"x": 1e3}, "2", [] ]';

test("Write saves JSON text exactly, directly and from Codemode", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await mkdir(path.join(cwd, ".pi-agent"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    const result = await new PiIntegrationTest({
      testName: "write-json-text",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      transport: "rpc",
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["write", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "object",
              name: "write",
              arguments: { path: "object.json", content: object },
            }),
            toolCall({
              id: "array",
              name: "write",
              arguments: { path: "array.json", content: array },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "script",
              name: "codemode",
              arguments: {
                code: `await tools.write({ path: "script.json", content: ${JSON.stringify(object)} });`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Write the JSON files.");

    for (const id of ["object", "array", "script"])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    expect(await readFile(path.join(cwd, "object.json"), "utf8")).toBe(object);
    expect(await readFile(path.join(cwd, "array.json"), "utf8")).toBe(array);
    expect(await readFile(path.join(cwd, "script.json"), "utf8")).toBe(object);

    // A provider parses JSON-looking text in a field that also allows objects; keep it string-only.
    const write = getCurrentTools(result.providerRequests[0]?.messages as Message[]).find(
      (tool) => tool.name === "write",
    );
    const content = (write?.parameters as { properties: Record<string, unknown> } | undefined)
      ?.properties.content;
    expect(content).toMatchObject({ type: "string" });
    expect(content).not.toHaveProperty("anyOf");
  });
});
