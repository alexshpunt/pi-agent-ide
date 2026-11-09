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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { textResultChecks } from "#integration/support/text-result-checks.ts";

test("Search results and line anchors survive edits made elsewhere in the file", async () => {
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
    const source = ".tmp/shared/main.txt";
    // Another session edits the file through the shell between the agent's calls.
    const code =
      textResultChecks +
      `
const file=${JSON.stringify(source)};
await tools.write({path:file,content:"one\\ntwo\\nthree\\nfour\\nfive\\n"});
const anchored=await tools.read({path:file,views:["anchors"]});
const anchorOf=(word)=>new RegExp("([0-9A-HJKMNP-TV-Z]{7})\\\\|"+word).exec(anchored)[1];
const four=await tools.search({path:file,query:"four"}).then(value => value.result);
const two=await tools.search({path:file,query:"two"}).then(value => value.result);
const five=anchorOf("five");
const three=anchorOf("three");
await tools.bash({command:"sed -i '1i zero' "+file});
await tools.replace({path:matches(four)[0],text:"FOUR"});
await tools.replace({path:file,start:five,text:"LAST\\n"});
check(body(await tools.read({path:file})).startsWith("zero\\none\\ntwo\\nthree\\nFOUR\\nLAST"),"Edits above did not keep the targets");
await tools.bash({command:"sed -i 's/two/2/' "+file});
const changedResult=await rejects(()=>tools.replace({path:matches(two)[0],text:"X"}),/expired|stale/);
await tools.bash({command:"sed -i 's/three/3/' "+file});
const changedAnchor=await rejects(()=>tools.replace({path:file,start:three,text:"X\\n"}),/stale/);
text(changedResult); text(changedAnchor);`;
    const run = await new PiIntegrationTest({
      testName: "anchors-survive-edits",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["write", "read", "search", "replace", "bash", "codemode"],
      conversation: [
        assistantMessage([toolCall({ id: "composed", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Targets checked.")]),
      ],
    }).run("Edit the file after another session changed it elsewhere");
    expect(getToolExecution(run, "composed").isError, getToolResultText(run, "composed")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, source), "utf8")).toBe("zero\none\n2\n3\nFOUR\nLAST\n");
  });
});

test("Anchors of repeated lines stay exact when other sessions insert lines above", async () => {
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
    const source = ".tmp/shared/repeated.cpp";
    const block = (name: string) =>
      `// ${name}\\ntemplate <typename T>\\nT ${name}(T v) {\\n  return v;\\n}\\n`;
    const code =
      textResultChecks +
      `
const file=${JSON.stringify(source)};
await tools.write({path:file,content:"${block("a")}${block("b")}${block("c")}"});
const anchored=String(await tools.read({path:file,views:["anchors"]}));
const rows=anchored.split("\\n").filter((row)=>/^[0-9A-HJKMNP-TV-Z]{7}\\|/.test(row)).map((row)=>{const at=row.indexOf("|"); return {anchor:row.slice(0,at), text:row.slice(at+1)};});
const closes=rows.filter((row)=>row.text==="}");
check(new Set(rows.map((row)=>row.anchor)).size===rows.length,"Two lines share an anchor");
const secondTemplate=rows.filter((row)=>row.text==="template <typename T>")[1].anchor;
const secondClose=closes[1].anchor;
// Another session inserts a repeated line and a new line above the whole file.
await tools.bash({command:"sed -i '1i }' "+file+" && sed -i '1i zero' "+file});
await tools.delete({path:file,start:secondTemplate,end:secondClose});
const after=body(await tools.read({path:file}));
check(!after.includes("T b(T v)") && after.includes("T a(T v)") && after.includes("T c(T v)"),"The wrong block was deleted: "+after);
check(after.startsWith("zero\\n}\\n// a"),"Lines above changed: "+after);
// A changed landmark makes the anchors of its repeated lines stale.
await tools.bash({command:"sed -i 's|// c|// C|' "+file});
const thirdTemplate=rows.filter((row)=>row.text==="template <typename T>")[2].anchor;
const stale=await rejects(()=>tools.delete({path:file,start:thirdTemplate}),/stale/);
text(stale);`;
    const run = await new PiIntegrationTest({
      testName: "anchors-repeated-lines-shift",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["write", "read", "search", "delete", "bash", "codemode"],
      conversation: [
        assistantMessage([toolCall({ id: "composed", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Targets checked.")]),
      ],
    }).run("Delete a block by anchors after another session inserted lines above");
    expect(getToolExecution(run, "composed").isError, getToolResultText(run, "composed")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, source), "utf8")).toBe(
      "zero\n}\n// a\ntemplate <typename T>\nT a(T v) {\n  return v;\n}\n// b\n// C\ntemplate <typename T>\nT c(T v) {\n  return v;\n}\n",
    );
  });
});
