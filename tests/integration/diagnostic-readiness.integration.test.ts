import { readFile, writeFile } from "node:fs/promises";
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

test("unavailable diagnostics remain visible without entering source selections", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "notes.unknown"), "alpha\nbeta\ngamma\n");
    const run = await new PiIntegrationTest({
      testName: "diagnostic-readiness-panels",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      isolateUserResources: true,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "select", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "scope",
              name: "codemode",
              arguments: {
                code: String.raw`
const result = await tools.read({path:"notes.unknown",views:["diagnostics","anchors","ghost"]});
if(typeof result !== "string" || !result.includes("unavailable") || !result.includes("No linter configured")) throw Error(result);
const outside = await tools.search({path:result,query:"regex:unavailable|No linter|Unknown view"});
if(!outside.includes("No matches found")) throw Error(outside);
store("diagnosticReadiness",result);
`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "panel",
              name: "codemode",
              arguments: {
                code: String.raw`
const beta = await tools.search({path:load("diagnosticReadiness"),query:"beta"});
const selected = await tools.select({path:beta,operation:{kind:"trim",side:"both"}});
const value = await tools.read({path:selected});
if(!value.includes("beta") || value.includes("alpha") || value.includes("gamma")) throw Error(value);
await tools.read({path:"notes.unknown",views:["diagnostics","anchors","ghost"]});
`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Inspect diagnostic readiness while preserving the file selection.");
    for (const id of ["scope", "panel"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    const rendered = run.tuiRenderedOutput.replace(/\s+/gu, " ");
    expect(rendered).toContain("lint: unavailable (No linter configured for this file).");
    expect(rendered).toContain("lsp: unavailable (No language server configured for this file).");
    expect(rendered).toContain("Unknown view ignored: ghost.");
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
    expect(rendered).toContain("gamma");
    expect(await readFile(path.join(cwd, "notes.unknown"), "utf8")).toBe("alpha\nbeta\ngamma\n");
  });
});

test("breakpoint lists spell out pending and verified through real Read", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = 'const message = "demo";\nconsole.log(message);\n';
    await writeFile(path.join(cwd, "demo.mjs"), source);
    const run = await new PiIntegrationTest({
      testName: "breakpoint-list-status-words",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      isolateUserResources: true,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["debug", "read", "insert", "delete", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "breakpoints",
              name: "codemode",
              arguments: {
                code: String.raw`
const created = await tools.debug({adapter:"node",program:"demo.mjs",source:"demo.mjs"});
if(typeof created !== "string") throw Error("Expected a readable debugger result");
const session = /Session: (debug:[a-f\d]+)/.exec(created)?.[1];
if(!session) throw Error(created);
try {
  await tools.read({path:session});
  const source = await tools.read({path:session+"/source",views:["anchors"]});
  const anchor = /(?:^|\n)(2#[A-F\d]+)\|/.exec(source)?.[1];
  if(!anchor) throw Error(source);
  await tools.insert({path:session+"/source",anchor,text:"breakpoint"});
  const pending = await tools.read({path:session+"/breakpoints"});
  if(!pending.includes("(pending)") || !pending.includes("demo.mjs:2")) throw Error(pending);
  await tools.insert({path:session,text:"start"});
  await tools.read({path:session});
  const verified = await tools.read({path:session+"/breakpoints"});
  if(!verified.includes("(verified)") || !verified.includes("demo.mjs:2")) throw Error(verified);
} finally {
  await tools.delete({path:session});
}
`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read pending and verified breakpoint statuses without inferring circle meanings.");
    expect(
      getToolExecution(run, "breakpoints").isError,
      getToolResultText(run, "breakpoints"),
    ).toBe(false);
    expect(await readFile(path.join(cwd, "demo.mjs"), "utf8")).toBe(source);
  });
});
