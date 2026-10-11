import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
  type AssistantMessageScenario,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { capabilityCases } from "#capabilities/cases.ts";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";

const done = assistantMessage([text("The byte checks finished.")]);
const message = (id: string, name: string, args: Record<string, unknown>) =>
  assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });

async function run(cwd: string, name: string, conversation: AssistantMessageScenario[]) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({ codemode: { mode: "on" } }),
  );
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
  );
  return new PiIntegrationTest({
    cwd,
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    extensions: [
      path.resolve("src/pi-agent-ide.ts"),
      "builtin:codemode",
      path.resolve("tests/integration/fixtures/parallel-edit-barrier.ts"),
    ],
    tools: ["replace", "insert", "delete", "undo", "read", "codemode"],
    rawMode: false,
    tuiSize: { cols: 160, rows: 180 },
    conversation: [...conversation, done],
  }).run("Keep all bytes outside the requested edits unchanged.");
}

test.each(["direct", "codemode"] as const)(
  "exact edits preserve line boundaries and EOF through %s",
  async (route) => {
    await withTempWorkspace(async (cwd) => {
      const cases: { file: string; before: string; start: string; text?: string; after: string }[] =
        [
          {
            file: "heading-lf.md",
            before: "## Old\n\nBody\n",
            start: "## Old",
            text: "## New",
            after: "## New\n\nBody\n",
          },
          {
            file: "heading-crlf.md",
            before: "## Old\r\n\r\nBody\r\n",
            start: "## Old",
            text: "## New",
            after: "## New\r\n\r\nBody\r\n",
          },
          {
            file: "terminated.md",
            before: "PREFIX\n## Old\n\nBody\n",
            start: "## Old\n",
            text: "## New\n",
            after: "PREFIX\n## New\n\nBody\n",
          },
          {
            file: "partial.txt",
            before: "left OLD right\n",
            start: "OLD",
            text: "NEW",
            after: "left NEW right\n",
          },
          ...["\n", "\r\n", ""].map((eol, index) => ({
            file: `eof-${index}.txt`,
            before: `First${eol || "\n"}Last${eol}`,
            start: "Last",
            text: "Final",
            after: `First${eol || "\n"}Final${eol}`,
          })),
          ...["\n", "\r\n", ""].map((ending, index) => {
            const eol = ending || "\n";
            return {
              file: `delete-${index}.txt`,
              before: `First${eol}Last${eol}Block${ending}`,
              start: "Last\nBlock",
              after: `First${ending}`,
            };
          }),
        ];
      await Promise.all(cases.map((entry) => writeFile(path.join(cwd, entry.file), entry.before)));
      const edits = cases.map((entry) => ({
        tool: entry.text === undefined ? "delete" : "replace",
        args: {
          path: entry.file,
          start: entry.start,
          ...(entry.text === undefined ? {} : { text: entry.text }),
        },
      }));
      const conversation =
        route === "direct"
          ? edits.map((edit, index) => message(`edit-${index}`, edit.tool, edit.args))
          : [
              message("script", "codemode", {
                code: `for (const edit of ${JSON.stringify(edits)}) text(await tools[edit.tool](edit.args));`,
              }),
            ];
      const result = await run(cwd, `exact-byte-boundaries-${route}`, conversation);
      for (const id of route === "direct" ? edits.map((_, index) => `edit-${index}`) : ["script"]) {
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      }
      for (const entry of cases) {
        expect(await readFile(path.join(cwd, entry.file), "utf8"), entry.file).toBe(entry.after);
      }
      expect(result.tuiRenderedOutput).toContain("## New");
      expect(result.tuiRenderedOutput).not.toContain("outside the current text");
    });
  },
);

test.each(["all", "allSettled"] as const)(
  "parallel same-file calls preserve all acknowledged effects with Promise.%s",
  async (method) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "insert.txt"), "first\nmiddle\nlast\n");
      await writeFile(path.join(cwd, "delete.txt"), "keep\nfirst\n\nmiddle\n\nlast\n");
      const collect =
        method === "allSettled"
          ? 'for (const result of results) { if (result.status !== "fulfilled") throw result.reason; text(result.value); }'
          : "for (const result of results) text(result);";
      const code = `const results = await Promise.${method}([
        tools.insert({path:"insert.txt",anchor:"first",text:"FIRST\\n"}),
        tools.insert({path:"./insert.txt",anchor:"middle",text:"MIDDLE\\n"}),
        tools.insert({path:"insert.txt",anchor:"last",text:"LAST\\n"}),
        tools.delete({path:"delete.txt",start:"first"}),
        tools.delete({path:"./delete.txt",start:"middle"}),
        tools.delete({path:"delete.txt",start:"last"})
      ]); ${collect}`;
      const result = await run(cwd, `parallel-byte-effects-${method}`, [
        message("script", "codemode", { code }),
        message("read-insert", "read", { path: "insert.txt" }),
      ]);
      expect(getToolExecution(result, "script").isError, getToolResultText(result, "script")).toBe(
        false,
      );
      expect(await readFile(path.join(cwd, "insert.txt"), "utf8")).toBe(
        "first\nFIRST\nmiddle\nMIDDLE\nlast\nLAST\n",
      );
      expect(await readFile(path.join(cwd, "delete.txt"), "utf8")).toBe("keep\n\n\n");
      const details = getToolExecutionDetails(getToolExecution(result, "script")) as {
        editorBatches: { applied: boolean; calls: { state: string }[] }[];
      };
      expect(details.editorBatches).toHaveLength(1);
      const task = capabilityCases.find(
        (candidate) => candidate.id === `parallel-edit-effects-${method}`,
      );
      if (!task) throw new Error("Missing parallel capability case");
      const events = result.traceEvents.flatMap((entry) =>
        "event" in entry && entry.event && typeof entry.event === "object"
          ? [entry.event as RunEvent]
          : [],
      );
      expect(validateRoute(task, events, "codemode")).toEqual({ passed: true, reasons: [] });
      expect(details.editorBatches[0]?.applied).toBe(true);
      expect(details.editorBatches[0]?.calls.map((call) => call.state)).toEqual(
        Array(6).fill("completed"),
      );
      expect(result.tuiRenderedOutput).toContain("FIRST");
      expect(result.tuiRenderedOutput).toContain("LAST");
    });
  },
);

test.each(["direct", "codemode"] as const)(
  "undo last reaches restoration with the full stale-anchor plugin through %s",
  async (route) => {
    await withTempWorkspace(async (cwd) => {
      const initial = "alpha\r\nbeta\r\n";
      await writeFile(path.join(cwd, "undo.txt"), initial);
      const edit = { path: "undo.txt", start: "beta", text: "changed" };
      const undo = { file: "undo.txt", change: "last" };
      const result = await run(
        cwd,
        `undo-last-byte-contract-${route}`,
        route === "direct"
          ? [message("edit", "replace", edit), message("undo", "undo", undo)]
          : [
              message("script", "codemode", {
                code: `text(await tools.replace(${JSON.stringify(edit)})); text(await tools.undo(${JSON.stringify(undo)}));`,
              }),
            ],
      );
      for (const id of route === "direct" ? ["edit", "undo"] : ["script"]) {
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      }
      expect(await readFile(path.join(cwd, "undo.txt"), "utf8")).toBe(initial);
      expect(result.tuiRenderedOutput).not.toContain('No text anchor resolver handled "last"');
      expect(result.tuiRenderedOutput).toContain("beta");
    });
  },
);
