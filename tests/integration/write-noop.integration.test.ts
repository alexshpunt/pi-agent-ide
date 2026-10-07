import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
import { textResultChecks } from "#integration/support/text-result-checks.js";

test("an identical Write commits pending edits without dropping their final post-edit work", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, "same.note"), "alpha\n");
    const run = await new PiIntegrationTest({
      testName: "write-noop-after-pending-edit",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/support/native-text-edit-probe.ts"),
        path.resolve("tests/integration/support/final-post-edit-extension.ts"),
      ],
      tools: ["replace", "write", "read", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "noop",
              name: "codemode",
              arguments: {
                code:
                  textResultChecks +
                  `await tools.replace({path:"same.note",start:"alpha",text:"first"});
const unchanged=await tools.write({path:"same.note",content:"first\\n"});
check(body(await tools.read({path:unchanged}))==="first\\n","Write did not see the committed pending edit");
text(unchanged);`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Pending edit finalized.")]),
      ],
    }).run("Keep the pending edit's formatter when the following Write is a no-op");
    expect(getToolExecution(run, "noop").isError, getToolResultText(run, "noop")).toBe(false);
    expect(await readFile(path.join(cwd, "same.note"), "utf8")).toBe("FIRST\n");
    const events = (await readFile(path.join(cwd, "format-events.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0] ?? "{}")).toMatchObject({ content: "first\n" });
  });
});

test("an identical Write keeps whole-file targets for file URLs and returned sources", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, "same.txt"), "same\n");
    const run = await new PiIntegrationTest({
      testName: "write-noop-whole-file-sources",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "write", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "noop",
              name: "codemode",
              arguments: {
                code:
                  textResultChecks +
                  `const source=await tools.read({path:"same.txt"});
const url=${JSON.stringify(pathToFileURL(path.join(cwd, "same.txt")).href)};
const unchanged=await tools.write({path:url,content:"same\\n"});
check(body(await tools.read({path:unchanged}))==="same\\n","File URL no-op lost its whole-file target");
const repeated=await tools.write({path:source,content:"same\\n"});
check(body(await tools.read({path:repeated}))==="same\\n","Whole-file source no-op lost its target");
text(unchanged); text(repeated);`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Whole-file no-op targets verified.")]),
      ],
    }).run("Keep an identical Write composable for every supported whole-file source");
    expect(getToolExecution(run, "noop").isError, getToolResultText(run, "noop")).toBe(false);
    expect(await readFile(path.join(cwd, "same.txt"), "utf8")).toBe("same\n");
  });
});
for (const mode of ["standalone", "codemode"] as const) {
  test.each(["", "same\nsame\n"])(
    `identical Write succeeds without saving or post-edit processing in ${mode} (%j)`,
    async (content) => {
      await withTempWorkspace(async (cwd) => {
        await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
        await writeFile(
          path.join(cwd, ".pi/settings.json"),
          JSON.stringify({ codemode: { mode: "on" } }),
        );
        await writeFile(
          path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
          JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
        );
        await writeFile(path.join(cwd, "same.note"), content);
        const call =
          mode === "standalone"
            ? toolCall({ id: "noop", name: "write", arguments: { path: "same.note", content } })
            : toolCall({
                id: "noop",
                name: "codemode",
                arguments: {
                  code:
                    textResultChecks +
                    `const unchanged=await tools.write({path:"same.note",content:${JSON.stringify(content)}});
const saved=await tools.read({path:unchanged});
${
  content.length === 0
    ? `const readBoundary=items(await tools.select({path:saved,operation:{kind:"position",edge:"after"}}));
check(readBoundary.length===1 && readBoundary[0].startColumn===0 && readBoundary[0].endColumn===0,"Empty no-op Read lost its source boundary");`
    : `check(body(saved)===${JSON.stringify(content)},"No-op lost its whole-file target");`
}
const found=await tools.search({path:unchanged,query:"same"});
check(matches(found).length===${content.length === 0 ? 0 : 2},"No-op lost its searchable whole-file target");
const point=await tools.select({path:unchanged,operation:{kind:"position",edge:"after"}});
check(items(point).length===1,"No-op lost the existing source boundary");
text(unchanged); text(point);`,
                },
              });
        const run = await new PiIntegrationTest({
          testName: `write-noop-${mode}-${content.length === 0 ? "empty" : "text"}`,
          artifactsDir: testArtifactsDir(import.meta.filename),
          cwd,
          rawMode: false,
          extensions: [
            path.resolve("src/pi-agent-ide.ts"),
            "builtin:codemode",
            path.resolve("tests/integration/support/native-text-edit-probe.ts"),
            path.resolve("tests/integration/support/final-post-edit-extension.ts"),
          ],
          tools: ["write", "read", "search", "select", "codemode"],
          conversation: [
            assistantMessage([call], { stopReason: "toolUse" }),
            assistantMessage([text("Identical Write finished.")]),
          ],
        }).run(
          "Keep an identical Write successful without touching the file or running its post-edit handlers",
        );
        expect(getToolExecution(run, "noop").isError, getToolResultText(run, "noop")).toBe(false);
        if (mode === "codemode") {
          expect(getToolResultText(run, "noop")).not.toContain("<empty-result>");
        }
        expect(await readFile(path.join(cwd, "same.note"), "utf8")).toBe(content);
        const events = (await readFile(path.join(cwd, "batch-events.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map(
            (line) => JSON.parse(line) as { type: string; name?: string; mtimeMs?: number | null },
          );
        const writes = events.filter((event) => event.name === "write");
        expect(writes).toHaveLength(2);
        expect(writes[0]?.mtimeMs).toEqual(expect.any(Number));
        expect(writes[1]?.mtimeMs).toBe(writes[0]?.mtimeMs);
        expect(
          events.filter((event) => event.type === "edit" || event.type === "post-edit"),
        ).toHaveLength(0);
        expect(
          await readFile(path.join(cwd, "format-events.jsonl"), "utf8").catch(() => null),
        ).toBeNull();
      });
    },
  );
}
