import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.ts";

type Call = Parameters<typeof toolCall>[0];
const original = "alpha\nbeta\nomega\n";
// Literal selectors select only their characters, so whole-line edits include the line break.
const line = "beta\n";
const target = "omega\n";
const cases = [
  { id: "insert", name: "insert", missing: { text: "NEW\n" }, selector: { anchor: line } },
  { id: "replace", name: "replace", missing: { text: "BETA" }, selector: { start: "beta" } },
  { id: "delete", name: "delete", missing: { end: line }, selector: { start: line } },
  {
    id: "copy-start",
    name: "copy",
    missing: { end: line, targetStart: target },
    selector: { start: line },
  },
  {
    id: "move-start",
    name: "move",
    missing: { end: line, targetStart: target },
    selector: { start: line },
  },
  {
    id: "copy-target",
    name: "copy",
    missing: { start: line },
    selector: { targetStart: target },
  },
  {
    id: "move-target",
    name: "move",
    missing: { start: line },
    selector: { targetStart: target },
  },
];

for (const route of ["single", "batch", "codemode"] as const) {
  test(`missing selectors leave files intact and allow recovery through ${route}`, async () => {
    await withTempWorkspace(async (cwd) => {
      await enableNativeCodemode(cwd);
      const files: Record<string, string> = {};
      for (const { id, name } of cases) {
        files[`${id}.txt`] = original;
        if (name === "copy" || name === "move") files[`${id}-target.txt`] = original;
      }
      for (const [file, content] of Object.entries(files))
        await writeFile(path.join(cwd, file), content);
      const calls = (recover: boolean): Call[] =>
        cases.map(({ id, name, missing, selector }) => ({
          id,
          name,
          arguments: {
            path: `${id}.txt`,
            ...(name === "copy" || name === "move" ? { target: `${id}-target.txt` } : {}),
            ...missing,
            ...(recover ? selector : {}),
          },
        }));
      const run = (recover: boolean) => {
        const steps = calls(recover);
        const messages =
          route === "codemode"
            ? [
                assistantMessage(
                  [
                    toolCall({
                      id: "script",
                      name: "codemode",
                      arguments: {
                        code: `for (const step of ${JSON.stringify(steps)}) {
  const value = await tools[step.name](step.arguments);
  if (${recover ? 'step.name !== "delete" && value === null' : "value !== null"}) throw Error(step.id);
}`,
                      },
                    }),
                  ],
                  { stopReason: "toolUse" },
                ),
              ]
            : route === "batch"
              ? [assistantMessage(steps.map(toolCall), { stopReason: "toolUse" })]
              : steps.map((step) => assistantMessage([toolCall(step)], { stopReason: "toolUse" }));
        return new PiIntegrationTest({
          testName: `missing-edit-selector-${route}-${recover ? "recover" : "reject"}`,
          artifactsDir: testArtifactsDir(import.meta.filename),
          cwd,
          extensions: ["builtin:codemode", path.resolve("src/pi-agent-ide.ts")],
          tools: ["insert", "replace", "delete", "copy", "move", "codemode"],
          conversation: [...messages, assistantMessage([text("Done")])],
        }).run("Apply the supplied calls.");
      };
      const rejected = await run(false);
      if (route === "codemode") {
        expect(getToolExecution(rejected, "script").isError).toBe(false);
        expect(getToolResultText(rejected, "script").match(/INVALID_REQUEST/gu)).toHaveLength(
          cases.length,
        );
      } else
        for (const { id } of cases) {
          expect(getToolExecution(rejected, id).isError).toBe(true);
          expect(getToolResultText(rejected, id)).toContain("INVALID_REQUEST");
        }
      for (const [file, content] of Object.entries(files))
        expect(await readFile(path.join(cwd, file), "utf8")).toBe(content);

      const recovered = await run(true);
      for (const id of route === "codemode" ? ["script"] : cases.map(({ id }) => id))
        expect(getToolExecution(recovered, id).isError).toBe(false);
      for (const { id, name } of cases) {
        const expected =
          name === "insert"
            ? "alpha\nbeta\nNEW\nomega\n"
            : name === "replace"
              ? "alpha\nBETA\nomega\n"
              : name === "delete" || name === "move"
                ? "alpha\nomega\n"
                : original;
        expect(await readFile(path.join(cwd, `${id}.txt`), "utf8")).toBe(expected);
        if (name === "copy" || name === "move")
          expect(await readFile(path.join(cwd, `${id}-target.txt`), "utf8")).toBe(
            `${original}beta\n`,
          );
      }
    });
  }, 120_000);
}
