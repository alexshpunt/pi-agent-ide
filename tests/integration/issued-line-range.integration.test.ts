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
} from "pi-coding-agent-test";
import { requiredValue } from "pi-agent-invariant";
import { textLineAnchors } from "pi-agent-text";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const file = "main.cpp";
const block =
  "typedef enum\n{\n    TYPE_UINT8,\n    TYPE_UINT16,\n    TYPE_UINT32,\n    TYPE_FLOAT,\n\n    MAX_TYPES\n} Datatype;\n";
const prototype = "int resize(\n    int width,\n    int height);\n";
const slot = "// move here\n";
const copySlot = "// copy here\n";
const gap = Array.from({ length: 9_600 }, (_, index) => `int keep_${index};\n`).join("");

function call(id: string, name: string, arguments_: Record<string, unknown>) {
  return assistantMessage([toolCall({ id, name, arguments: arguments_ })], {
    stopReason: "toolUse",
  });
}

async function run(cwd: string, name: string, calls: ReturnType<typeof call>[]) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
  );
  return new PiIntegrationTest({
    cwd,
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    extensions: [path.resolve("src/pi-agent-ide.ts")],
    tools: ["read", "replace", "delete", "move", "bash"],
    rawMode: false,
    conversation: [...calls, assistantMessage([text("Finished.")])],
  }).run("Edit a shared file using the previously issued anchors.");
}

function peerWrite(expression: string) {
  return call("peer", "bash", {
    command: `node -e ${JSON.stringify(
      `const fs = require('node:fs'); const p = '${file}'; const text = fs.readFileSync(p, 'utf8'); fs.writeFileSync(p, ${expression});`,
    )}`,
  });
}

function rangeAnchors(before: string, selection: string) {
  const startLine = before.slice(0, before.lastIndexOf(selection)).split("\n").length - 1;
  const anchors = textLineAnchors(file, before);
  return {
    start: requiredValue(anchors[startLine]),
    end: requiredValue(anchors[startLine + selection.trimEnd().split("\n").length - 1]),
  };
}

test.each(["delete", "replace", "move"] as const)(
  "%s refuses a split range issued by an ambiguous exact-text refusal",
  async (tool) =>
    withTempWorkspace(async (cwd) => {
      const source = path.join(cwd, file);
      const initial = `${slot}\n${copySlot}\n${gap}${prototype}\n${block}\nint keep_last;\n`;
      const issued = rangeAnchors(initial.replace(copySlot, block), block);
      await writeFile(source, initial);
      const runResult = await run(cwd, tool, [
        call("copy", "replace", {
          path: file,
          at: copySlot.trimEnd(),
          text: block.trimEnd(),
        }),
        call("ambiguous", "delete", { path: file, start: block.trimEnd() }),
        peerWrite(
          `text.replace(${JSON.stringify(prototype)}, '').replace(${JSON.stringify(slot)}, ${JSON.stringify(prototype)})`,
        ),
        call("edit", tool, {
          path: file,
          ...(tool === "replace"
            ? { from: issued.start, through: issued.end, text: "REPLACED" }
            : issued),
          ...(tool === "move" ? { target: file, targetStart: "int keep_last;" } : {}),
        }),
      ]);
      const recovery = getToolResultText(runResult, "ambiguous");
      expect(recovery).toContain(`${issued.start}|typedef enum`);
      expect(recovery).toContain(`${issued.end}|} Datatype;`);
      expect(
        (await readFile(source, "utf8")) ===
          initial.replace(copySlot, block).replace(prototype, "").replace(slot, prototype),
      ).toBe(true);
      expect(getToolExecutionDetails(getToolExecution(runResult, "edit"))).toMatchObject({
        effect: "not-applied",
        results: [{ data: { errors: [{ code: "STALE_ANCHOR_RANGE" }] } }],
      });
    }),
);

test.each(["same-size interior edit", "unrelated shift"] as const)(
  "paired anchors check the original span after a peer's %s",
  async (change) =>
    withTempWorkspace(async (cwd) => {
      const initial = `before\n${block}after\n`;
      const source = path.join(cwd, file);
      const issued = rangeAnchors(initial, block);
      const changed = change === "same-size interior edit";
      await writeFile(source, initial);
      const runResult = await run(cwd, change, [
        call("issue", "read", { path: file, views: ["anchors"] }),
        peerWrite(changed ? "text.replace('TYPE_UINT8', 'TYPE_INT08')" : "'inserted\\n' + text"),
        // A fresh read can reissue identical endpoint hashes. It must not erase the old witness.
        call("reread", "read", { path: file, views: ["anchors"] }),
        call("edit", "delete", { path: file, ...issued }),
      ]);
      expect(getToolResultText(runResult, "reread")).toContain(`${issued.start}|typedef enum`);
      expect(getToolResultText(runResult, "reread")).toContain(`${issued.end}|} Datatype;`);
      expect(await readFile(source, "utf8")).toBe(
        changed ? initial.replace("TYPE_UINT8", "TYPE_INT08") : "inserted\nbefore\nafter\n",
      );
      if (changed) {
        expect(getToolExecutionDetails(getToolExecution(runResult, "edit"))).toMatchObject({
          effect: "not-applied",
          results: [{ data: { errors: [{ code: "STALE_ANCHOR_RANGE" }] } }],
        });
      }
    }),
);
