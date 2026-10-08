import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const tools = [
  "read",
  "bash",
  "write",
  "search",
  "diff",
  "replace",
  "insert",
  "delete",
  "copy",
  "move",
  "select",
  "undo",
  "stage",
  "unstage",
  "debug",
];

function hasSchemaDefault(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => key === "default" || hasSchemaDefault(child));
}

test("IDE schemas and native execution preserve omitted fields and explicit zero limits", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "before.txt"), "before\n");
    await writeFile(path.join(cwd, "after.txt"), "after\n");
    await writeFile(path.join(cwd, "unwanted.txt"), "remove this file\n");
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
    const run = await new PiIntegrationTest({
      testName: "ide-tool-omission",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools,
      conversation: [
        call("diff-all", "diff", { before: { path: "before.txt" }, after: { path: "after.txt" } }),
        call("diff-zero", "diff", {
          before: { path: "before.txt", limit: 0 },
          after: { path: "after.txt", limit: 0 },
        }),
        call("copy-all", "copy", { path: "before.txt", target: "copied.txt" }),
        call("delete-all", "delete", { path: "unwanted.txt" }),
        assistantMessage([text("Finished")]),
      ],
    }).run("Compare full files and explicit empty ranges, then copy and delete whole files.");
    for (const id of ["diff-all", "diff-zero", "copy-all", "delete-all"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(getToolResultText(run, "diff-all")).toContain("-before");
    expect(getToolResultText(run, "diff-all")).toContain("+after");
    expect(getToolResultText(run, "diff-zero")).toContain("No differences");
    expect(await readFile(path.join(cwd, "copied.txt"), "utf8")).toBe("before\n");
    expect(await readFile(path.join(cwd, "before.txt"), "utf8")).toBe("before\n");
    await expect(readFile(path.join(cwd, "unwanted.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const declared = getCurrentTools(run.providerRequests[0]?.messages as Message[]);
    for (const name of tools) {
      const tool = declared.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      expect(hasSchemaDefault(tool?.parameters), name).toBe(false);
    }
  });
}, 60_000);
