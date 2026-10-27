import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.js";

for (const route of ["direct", "codemode"] as const) {
  test(`selected text keeps its exact boundaries through ${route}`, async () => {
    await withTempWorkspace(async (cwd) => {
      await enableNativeCodemode(cwd);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
      );
      const files: Record<string, string> = {};
      const expected: Record<string, string> = {};
      const edits: { tool: string; args: Record<string, unknown> }[] = [];
      for (const [index, eol] of ["\n", "\r\n"].entries()) {
        const file = `restore-${index}.txt`;
        files[file] = `base${eol}`;
        expected[file] = files[file];
        edits.push(
          { tool: "insert", args: { path: file, anchor: "base", text: "added" } },
          { tool: "delete", args: { path: file, start: "added" } },
          { tool: "insert", args: { path: file, anchor: "base", before: true, text: "correct" } },
        );
        expected[file] = `correct${eol}base${eol}`;
        for (const tool of ["delete", "replace"]) {
          const name = `${tool}-${index}.txt`;
          files[name] = `keep${eol}${eol}尾🙂`;
          expected[name] = `keep${eol}${eol}`;
          edits.push({
            tool,
            args: { path: name, start: "尾🙂", ...(tool === "replace" ? { text: "" } : {}) },
          });
        }
      }
      for (const tool of ["copy", "move"]) {
        for (const [index, ending] of ["", "\r\n"].entries()) {
          const source = `${tool}-source-${index}.txt`;
          const target = `${tool}-target-${index}.txt`;
          files[source] = `keep\r\n段🙂${ending}`;
          files[target] = "left TARGET right\n";
          expected[source] = tool === "move" ? "keep\r\n" : files[source];
          expected[target] = `left 段🙂${ending} right\n`;
          edits.push({
            tool,
            args: {
              path: source,
              start: "段🙂",
              target,
              targetStart: "TARGET",
              targetEnd: "TARGET",
            },
          });
        }
      }
      for (const before of [false, true]) {
        const file = `insert-${before}.txt`;
        files[file] = "pre α\r\nβ end\r\n";
        expected[file] = before ? "pre +α\r\nβ end\r\n" : "pre α\r\nβ+ end\r\n";
        edits.push({ tool: "insert", args: { path: file, anchor: "α\nβ", text: "+", before } });
      }
      await Promise.all(
        Object.entries(files).map(([file, content]) => writeFile(path.join(cwd, file), content)),
      );
      const call = (id: string, name: string, args: Record<string, unknown>) =>
        assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
      // Complete each batch before resolving a dependent edit against the new file.
      const conversation = edits.map((edit, index) =>
        route === "direct"
          ? call(`edit-${index}`, edit.tool, edit.args)
          : call(`edit-${index}`, "codemode", {
              code: `text(await tools.${edit.tool}(${JSON.stringify(edit.args)}));`,
            }),
      );
      const result = await new PiIntegrationTest({
        cwd,
        testName: `exact-range-contract-${route}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "insert", "replace", "delete", "copy", "move", "codemode"],
        isolateUserResources: true,
        rawMode: false,
        tuiSize: { cols: 140, rows: 100 },
        conversation: [...conversation, assistantMessage([text("Completed the range edits.")])],
      }).run("Apply the supplied edits without changing bytes outside their selections.");
      for (const id of edits.map((_, index) => `edit-${index}`)) {
        expect(getToolExecution(result, id).isError).toBe(false);
      }
      for (const [file, content] of Object.entries(expected)) {
        expect(await readFile(path.join(cwd, file)), file).toEqual(Buffer.from(content));
      }
      expect(result.tuiRenderedOutput).toContain("α");
      expect(result.tuiRenderedOutput).toContain("β");
    });
  }, 120_000);

  test(`ambiguous and stale selections stay rejected through ${route}`, async () => {
    await withTempWorkspace(async (cwd) => {
      await enableNativeCodemode(cwd);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
      );
      const ambiguous = "duplicate\nother\nduplicate\n";
      await writeFile(path.join(cwd, "ambiguous.txt"), ambiguous);
      await writeFile(path.join(cwd, "stale.txt"), "keep\nOLD\n");
      const call = (id: string, name: string, args: Record<string, unknown>) =>
        assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
      const conversation =
        route === "direct"
          ? [
              call("ambiguous", "replace", {
                path: "ambiguous.txt",
                start: "duplicate",
                text: "BAD",
              }),
              call("search", "search", { path: "stale.txt", query: "OLD" }),
              call("change", "replace", { path: "stale.txt", start: "OLD", text: "NEW" }),
              call("stale", "delete", { path: "stale.txt", start: "SEARCH#RUNTIME:1:1:match" }),
            ]
          : [
              call("ambiguous", "codemode", {
                code: 'await tools.replace({path:"ambiguous.txt",start:"duplicate",text:"BAD"});',
              }),
              call("stale", "codemode", {
                code: 'const selected = await tools.search({path:"stale.txt",query:"OLD"}); await tools.replace({path:"stale.txt",start:"OLD",text:"NEW"}); await tools.delete({path:selected.result});',
              }),
            ];
      const result = await new PiIntegrationTest({
        cwd,
        testName: `exact-range-rejections-${route}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          path.resolve(
            "tests/integration/extensions/pi-agent-text-editor/support/search-anchor-runtime-extension.ts",
          ),
          "builtin:codemode",
        ],
        tools: ["search", "replace", "delete", "codemode"],
        isolateUserResources: true,
        rawMode: false,
        conversation: [
          ...conversation,
          assistantMessage([text("Completed the rejection checks.")]),
        ],
      }).run("Reject ambiguous and stale selections without changing unselected text.");
      for (const id of ["ambiguous", "stale"])
        expect(getToolExecution(result, id).isError).toBe(true);
      if (route === "direct") {
        for (const id of ["search", "change"])
          expect(getToolExecution(result, id).isError).toBe(false);
      }
      expect(await readFile(path.join(cwd, "ambiguous.txt"))).toEqual(Buffer.from(ambiguous));
      expect(await readFile(path.join(cwd, "stale.txt"))).toEqual(Buffer.from("keep\nNEW\n"));
    });
  }, 120_000);
}
