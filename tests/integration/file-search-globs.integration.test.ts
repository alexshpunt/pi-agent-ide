import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";

test("real Pi discovers file globs below an ignored parent", async () => {
  const root = path.resolve(".agents/tmp/file-search-runtime");
  await mkdir(root, { recursive: true });
  const parent = await mkdtemp(path.join(root, "run-"));
  const cwd = path.join(parent, "results/workspace");
  try {
    await mkdir(path.join(parent, ".git"));
    await writeFile(path.join(parent, ".gitignore"), "results/\n");
    await mkdir(path.join(cwd, "cases"), { recursive: true });
    await writeFile(
      path.join(cwd, "cases/part-001.test.ts"),
      "legacy\u200bCheckout\n".repeat(1000),
    );
    const queries = ["files:cases/*.test.ts", "files:**/cases/*.test.ts", "files:*.test.ts"];
    const result = await new PiIntegrationTest({
      testName: "file-search-globs",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["search"],
      conversation: [
        ...queries.map((query, index) =>
          assistantMessage(
            [toolCall({ id: `search-${index}`, name: "search", arguments: { query, path: "." } })],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Find the matching files using each supplied query.");
    for (let index = 0; index < queries.length; index += 1) {
      const call = getToolExecution(result, `search-${index}`);
      expect(call.isError).toBe(false);
      expect(getToolExecutionDetails(call)).toMatchObject({
        resolverId: "files",
        payload: { files: ["cases/part-001.test.ts"], complete: true },
      });
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);
