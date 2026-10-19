import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
import { withTextResultChecks } from "#integration/support/text-result-checks.js";

const initial = "alpha\nbeta\ngap\n});\nINSERT_HERE\n});\ntail\n";
const copy = {
  path: "same.txt",
  start: "alpha",
  end: "beta",
  targetStart: "});",
};

test.each([
  ["standalone", "targetStart"],
  ["codemode", "targetStart"],
  ["standalone", "targetEnd"],
  ["codemode", "targetEnd"],
] as const)(
  "Copy recovers a %s %s failure without blocking its validated source",
  async (surface, field) => {
    await withTempWorkspace(async (cwd) => {
      const file = path.join(cwd, "same.txt");
      await writeFile(file, initial);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/settings.json"),
        JSON.stringify({ codemode: { mode: "on" } }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
      );
      const request =
        field === "targetStart" ? copy : { ...copy, targetStart: "gap", targetEnd: "});" };
      const rejectCopy = `await rejects(()=>tools.copy(${JSON.stringify(request)}),/ambiguous/);`;
      const corrected =
        field === "targetStart"
          ? '{path:"same.txt",start:"alpha",end:"beta",targetStart:destination}'
          : '{path:"same.txt",start:"alpha",end:"beta",targetStart:"gap",targetEnd:destination}';
      const run = await new PiIntegrationTest({
        testName: `copy-destination-recovery-${surface}-${field}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        rawMode: false,
        cwd,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "copy", "codemode"],
        conversation: [
          ...(surface === "standalone"
            ? [
                assistantMessage(
                  [toolCall({ id: "ambiguous-copy", name: "copy", arguments: request })],
                  { stopReason: "toolUse" },
                ),
              ]
            : []),
          assistantMessage(
            [
              toolCall({
                id: "corrected-copy",
                name: "codemode",
                arguments: {
                  code: withTextResultChecks(String.raw`
${surface === "codemode" ? rejectCopy : ""}
const current = await tools.read({path:"same.txt",views:["anchors"]});
const destination = /^(\d+#[A-F\d]+)\|INSERT_HERE$/m.exec(current)?.[1];
check(destination,"Missing issued destination anchor");
text(await tools.copy(${corrected}));
`),
                },
                chunks: { kind: "fixed", size: 4096 },
                delayMs: 0,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Copy recovery finished.")]),
        ],
      }).run(
        "Copy the source block and correct a rejected destination without changing the source selectors",
      );

      if (surface === "standalone") {
        expect(getToolExecution(run, "ambiguous-copy").isError).toBe(true);
        expect(getToolResultText(run, "ambiguous-copy")).toContain("ambiguous");
      }
      expect(
        getToolExecution(run, "corrected-copy").isError,
        getToolResultText(run, "corrected-copy"),
      ).toBe(false);
      expect(await readFile(file, "utf8")).toBe(
        field === "targetStart"
          ? "alpha\nbeta\ngap\n});\nINSERT_HERE\nalpha\nbeta\n});\ntail\n"
          : "alpha\nbeta\nalpha\nbeta\n});\ntail\n",
      );
    });
  },
);
