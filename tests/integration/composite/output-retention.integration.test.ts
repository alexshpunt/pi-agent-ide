import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall as nativeToolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";

const root = path.resolve();
const extension = path.join(root, "tests/integration/composite/support/output-retention-ide.ts");
const toolCall = (input: Parameters<typeof nativeToolCall>[0]) =>
  nativeToolCall({ ...input, chunks: { kind: "fixed", size: 1000000 }, delayMs: 0 });
const readSaved = `
  const savedPath = (result) => {
    const match = /Full output: ("(?:\\\\.|[^"\\\\])*")/.exec(result);
    if (!match) throw new Error("Missing complete output reference");
    return JSON.parse(match[1]);
  };
`;

test("reads complete saved text through line and byte windows after direct and nested limits", async () => {
  const parent = path.join(root, ".tmp/output-retention");
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(path.join(parent, "workspace-"));
  try {
    const full = Array.from(
      { length: 6000 },
      (_, index) => `RETAINED_ROW_${index}: ${"value ".repeat(20)}`,
    ).join("\n");
    await writeFile(path.join(cwd, "source.txt"), full);
    const result = await new PiIntegrationTest({
      testName: "saved-output-recovery",
      cwd,
      artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
      extensions: [extension, "builtin:codemode"],
      tools: ["read", "write", "replace", "codemode"],
      isolateUserResources: true,
      transport: "rpc",
      systemPrompt: "Run the scripted recovery checks.",
      timeoutMs: 60000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "direct-read",
              name: "read",
              arguments: { path: "source.txt", limit: 1000000 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "nested-recovery",
              name: "codemode",
              arguments: {
                code:
                  readSaved +
                  `
          const full = Array.from({length:6000}, (_,index)=>"RETAINED_ROW_"+index+": "+"value ".repeat(20)).join("\\n");
          const written = await tools.write({path:"written.txt",content:full});
          if (written.includes("RETAINED_ROW_")) throw new Error("Write leaked the file body");
          const inspected = await tools.read({path:written,limit:1000000});
          const file = savedPath(inspected);
          const tail = await tools.read({path:file,offset:-1,limit:1});
          if (!tail.includes("RETAINED_ROW_5999")) throw new Error("Saved Write tail was lost");
          const bytes = await tools.read({path:"raw:"+file,offset:-200,limit:200});
          if (!bytes.includes("Bytes")) throw new Error("Saved Write does not support byte reads");
          try { await tools.replace({path:"missing/"+"😀".repeat(30000),start:"x",text:"y"}); }
          catch (error) {
            const source = savedPath(String(error));
            const piece = await tools.read({path:"raw:"+source,offset:-100,limit:100});
            if (!piece.includes("Bytes")) throw new Error("Saved blocked error is not readable");
          }
          text("Saved text, tail and bytes recovered.");
        `,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "parent-output",
              name: "codemode",
              arguments: {
                code: '// @options: {"max_output_tokens":50000}\ntext(Array.from({length:6000},(_,index)=>"PARENT_ROW_"+index).join("\\n"));',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "invalid-read",
              name: "read",
              arguments: { path: ["😀".repeat(30000)] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
    }).run("Read complete archived output without overflowing provider context");
    expect(getToolResultMessage(result, "direct-read").isError).toBe(false);
    expect(
      getToolResultMessage(result, "nested-recovery").isError,
      getToolResultText(result, "nested-recovery"),
    ).toBe(false);
    expect(getToolResultText(result, "nested-recovery")).toContain(
      "Saved text, tail and bytes recovered",
    );
    expect(getToolResultMessage(result, "parent-output").isError).toBe(false);
    expect(getToolResultMessage(result, "invalid-read").isError).toBe(true);
    const audit: unknown = JSON.parse(
      await readFile(path.join(cwd, "retention-audit.json"), "utf8"),
    );
    if (!audit || typeof audit !== "object") throw new Error("Missing retention audit");
    for (const id of ["direct-read", "parent-output", "invalid-read"]) {
      if (!(id in audit)) throw new Error(`No saved file for ${id}`);
      const item = audit[id as keyof typeof audit] as {
        files: string[];
        bytes: number;
        tail: string;
      };
      expect(item.files).toHaveLength(1);
      expect(item.bytes).toBeGreaterThan(51200);
      if (id === "direct-read") expect(item.tail).toContain("RETAINED_ROW_5999");
      if (id === "parent-output") expect(item.tail).toContain("PARENT_ROW_5999");
      for (const file of item.files)
        await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect((await readFile(path.join(cwd, "written.txt"), "utf8")) === full).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);
