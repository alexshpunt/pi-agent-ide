import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test("Read errors provide executable recovery without exposing resolvers or granting source authority", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = "alpha\nbeta\ngamma\n";
    await writeFile(path.join(cwd, "notes.txt"), source);
    await writeFile(path.join(cwd, "items.txt"), '{"items":["alpha","beta"]}\n');
    const run = await new PiIntegrationTest({
      testName: "read-failure-recovery",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      isolateUserResources: true,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "recover",
              name: "codemode",
              arguments: {
                code: String.raw`
async function rejected(request) {
  try { await tools.read(request); } catch(error) { return error.message; }
  throw Error("Read unexpectedly succeeded");
}
const absent = await rejected({path:"notes.txt#not-in-the-file"});
const action = absent.match(/("(?:[^"\\\r\n]|\\.)*")(?=[^\n]*views=\["anchors"\])/u);
if(!action || absent.includes("FRAGMENT_FAILED")) throw Error(absent);
const fresh = await tools.read({path:JSON.parse(action[1]),views:["anchors"]});
if(typeof fresh !== "string" || !fresh.includes("|beta")) throw Error(fresh);
const beta = await tools.search({path:fresh,query:"beta"});
const selected = await tools.read({path:beta});
if(!selected.includes("beta") || selected.includes("alpha")) throw Error(selected);
store("failedRead",absent);
const missing = await rejected({});
if(!missing.includes("path") || missing.includes("INVALID_REQUEST")) throw Error(missing);
const symbol = await rejected({path:"symbol:notes.txt"});
if(!symbol.includes("selector") || symbol.includes("resolver") || symbol.includes("RESOLVE_FAILED")) throw Error(symbol);
const raw = await rejected({path:"raw:notes.txt",views:["anchors"]});
if(!raw.includes("views")) throw Error(raw);
const bytes = await tools.read({path:"raw:notes.txt",limit:4});
if(!bytes.includes("Bytes 0..4 (end exclusive), 17 bytes total") || !bytes.includes("|alph|")) throw Error(bytes);
const jq = await rejected({path:"items.txt",views:["jq:.items","anchors"]});
if(!jq.includes("jq:<filter>")) throw Error(jq);
const values = await tools.read({path:"items.txt",views:["jq:.items[]"]});
if(!values.includes('"alpha"') || !values.includes('"beta"')) throw Error(values);
`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "failure-authority",
              name: "codemode",
              arguments: {
                code: String.raw`
let rejected = false;
try { await tools.replace({path:load("failedRead"),text:"WRONG"}); } catch { rejected = true; }
if(!rejected) throw Error("A failed Read granted edit authority");
const control = await tools.read({path:"notes.txt"});
if(!control.endsWith("alpha\nbeta\ngamma\n")) throw Error(control);
try { await tools.read({path:"notes.txt#not-in-the-file"}); } catch(error) { text(error.message); }
`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Recover from Read errors using current sources, not failed results.");
    for (const id of ["recover", "failure-authority"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(await readFile(path.join(cwd, "notes.txt"), "utf8")).toBe(source);
    const rendered = run.tuiRenderedOutput.replace(/\s+/gu, " ");
    expect(rendered).toContain('views=["anchors"]');
    expect(rendered).toContain("notes.txt");
    expect(getToolResultText(run, "failure-authority")).not.toContain("FRAGMENT_FAILED");
  });
});

test("non-text line-range recovery preserves native image delivery", async () => {
  await withTempWorkspace(async (cwd) => {
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(cwd, "pixel.png"), image);
    const run = await new PiIntegrationTest({
      testName: "read-nontext-recovery",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      isolateUserResources: true,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "image",
              name: "codemode",
              arguments: {
                code: String.raw`
let message;
try { await tools.read({path:"pixel.png",offset:1,limit:1}); } catch(error) { message=error.message; }
if(!message || !message.includes("offset") || !message.includes("limit")) throw Error(message ?? "Expected failure");
text(message);
const image = await tools.read({path:"pixel.png"});
if(typeof image !== "string") throw Error("Read must return a string");
`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Use the Read failure recovery to inspect native image content.");
    expect(getToolExecution(run, "image").isError, getToolResultText(run, "image")).toBe(false);
    expect(getToolResultMessage(run, "image").content.some((block) => block.type === "image")).toBe(
      true,
    );
    expect(await readFile(path.join(cwd, "pixel.png"))).toEqual(image);
  });
});
