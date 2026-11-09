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

test("A list of match references from a limited search survives other sessions' edits and reports every unusable item at once", async () => {
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
    const source = ".tmp/shared/rename.cpp";
    const code =
      textResultChecks +
      String.raw`
const file=${JSON.stringify(source)};
const lines=Array.from({length:160},(_,i)=>"v_"+i+" = rename_me(a_"+i+") + other(a_"+i+");");
await tools.write({path:file,content:lines.join("\n")+"\n"});
// The search hits its limit, so references beyond the 100th and an incomplete result are both in play.
const found=String(await tools.search({path:file,query:"rename_me",limit:120}).then(value=>value.result));
const ref=(n)=>{const hit=matches(found).find(item=>item.endsWith(":"+n+":match")); check(hit,"No reference "+n+" in "+found.slice(0,400)); return hit;};
const [r3,r110,r112,r115,r117,r120]=[3,110,112,115,117,120].map(ref);
// Another session shifts the file and edits other parts of every second line.
await tools.bash({command:"sed -i '2~2s/other(/different(/' "+file+" && sed -i '1i top' "+file});
await tools.replace({path:[r3,r110,r112],text:"renamed"});
const after=await tools.read({path:file});
check(body(String(after)).includes("v_2 = renamed(a_2)")&&body(String(after)).includes("v_109 = renamed(a_109)")&&body(String(after)).includes("v_111 = renamed(a_111)"),"Targets were not applied at their new lines: "+String(after).slice(0,500));
// Two matches change their own text: one call names both and leaves the file untouched.
await tools.bash({command:"sed -i '116s/rename_me/x_me/;118s/rename_me/y_me/' "+file});
const message=await rejects(()=>tools.replace({path:[r115,r117,r120],text:"renamed"}),/2 of 3 references/);
check(message.includes(r115)&&message.includes(r117)&&!message.includes(r120),"Error did not name exactly the unusable items: "+message);
text(message);`;
    const run = await new PiIntegrationTest({
      testName: "anchors-list-concurrent",
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
    }).run("Rename matches by a list of references while another session edits the file");
    expect(getToolExecution(run, "composed").isError, getToolResultText(run, "composed")).toBe(
      false,
    );
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
