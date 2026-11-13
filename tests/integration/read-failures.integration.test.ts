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
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

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
// A failed Read resolves to null; its recovery steps are listed in the Codemode result.
async function rejected(request) {
  const failure = await tools.read(request);
  if(failure !== null) throw Error("Read did not fail: "+JSON.stringify(failure));
}
await rejected({path:"notes.txt#not-in-the-file"});
// The test checks that the listed recovery Read names this file with the anchors view.
const fresh = await tools.read({path:"notes.txt",views:["anchors"]});
if(typeof fresh?.text !== "string" || !fresh.text.includes("|beta")) throw Error(JSON.stringify(fresh));
const beta = await tools.search({path:fresh,query:"beta"}).then(value => value.result);
const selected = await tools.read({path:beta});
if(!selected.text.includes("beta") || selected.text.includes("alpha")) throw Error(selected.text);
await rejected({});
await rejected({path:"raw:notes.txt",views:["anchors"]});
// Base64 of "alph", the first four bytes.
const bytes = await tools.read({path:"raw:notes.txt",limit:4});
if(bytes?.bytes !== "YWxwaA==") throw Error(JSON.stringify(bytes));
await rejected({path:"items.txt",views:["jq:.items","anchors"]});
const values = await tools.read({path:"items.txt",views:["jq:.items[]"]});
if(!values.text.includes('"alpha"') || !values.text.includes('"beta"')) throw Error(values.text);
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
const control = await tools.read({path:"notes.txt"});
if(control?.text !== "alpha\nbeta\ngamma\n") throw Error(JSON.stringify(control));
const again = await tools.read({path:"notes.txt#not-in-the-file"});
if(again !== null) throw Error("A failed Read stopped resolving to null");
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

    const recovered = codemodeFailures(getToolResultText(run, "recover"));
    expect(recovered).toMatch(/^4 of \d+ IDE calls failed:\n/u);
    // A failed Read issues no system-result reference, so its text cannot grant edit authority.
    expect(recovered).not.toContain("<system-result");
    const [absent, missing, raw, jq] = failureEntries(recovered);
    expect(absent).toMatch(/^read notes\.txt#not-in-the-file\n/u);
    expect(absent).not.toContain("FRAGMENT_FAILED");
    const action = /("(?:[^"\\\r\n]|\\.)*")(?=[^\n]*views=\["anchors"\])/u.exec(absent ?? "");
    expect(action, absent).not.toBeNull();
    // The shared Pi process runs in its own copy of the workspace, so compare the file name.
    expect(JSON.parse(action?.[1] ?? '""') as string).toMatch(/(?:^|\/)notes\.txt$/u);
    expect(missing).toMatch(/^read\n/u);
    expect(missing).toContain("path");
    expect(missing).not.toContain("INVALID_REQUEST");
    expect(raw).toMatch(/^read raw:notes\.txt\n/u);
    expect(raw).toContain("views");
    expect(jq).toMatch(/^read items\.txt\n/u);
    expect(jq).toContain("jq:<filter>");
    const again = failureEntries(codemodeFailures(getToolResultText(run, "failure-authority")));
    expect(again).toHaveLength(1);
    expect(again[0]).toContain('views=["anchors"]');
  });
});

/** The entries of a Codemode failure block, each starting with its tool and source. */
function failureEntries(block: string): string[] {
  return block.split(/^- /mu).slice(1);
}

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
const failure = await tools.read({path:"pixel.png",offset:1,limit:1});
if(failure !== null) throw Error("Expected failure: "+JSON.stringify(failure));
const image = await tools.read({path:"pixel.png"});
if(image?.type !== "image" || typeof image.data !== "string") throw Error("Read must return an image block");
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
    const failure = codemodeFailures(getToolResultText(run, "image"));
    expect(failure).toMatch(/^1 of 2 IDE calls failed:\n- read pixel\.png\n/u);
    expect(failure).toContain("offset");
    expect(failure).toContain("limit");
    expect(getToolResultMessage(run, "image").content.some((block) => block.type === "image")).toBe(
      true,
    );
    expect(await readFile(path.join(cwd, "pixel.png"))).toEqual(image);
  });
});
