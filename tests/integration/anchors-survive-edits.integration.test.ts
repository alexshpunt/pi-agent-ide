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
import { codemodeFailures } from "#integration/support/codemode-failures.ts";

/** Each failed IDE call of a Codemode result: its tool and source line, then its reason. */
function failedCalls(output: string): string[] {
  // Guides that a call delivers on first use follow the block; they are not failures.
  const [block = ""] = codemodeFailures(output).split("\n\n---\n\n# Guide:");
  return block.split("\n- ").slice(1);
}

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
const anchorOf=(word)=>new RegExp("([0-9A-HJKMNP-TV-Z]{7})\\\\|"+word).exec(anchored.text)[1];
const four=await tools.search({path:file,query:"four"}).then(value => value.result);
const two=await tools.search({path:file,query:"two"}).then(value => value.result);
const five=anchorOf("five");
const three=anchorOf("three");
await tools.bash({command:"sed -i '1i zero' "+file});
await tools.replace({path:matches(four)[0],text:"FOUR"});
await tools.replace({path:file,start:five,text:"LAST\\n"});
check((await tools.read({path:file})).text.startsWith("zero\\none\\ntwo\\nthree\\nFOUR\\nLAST"),"Edits above did not keep the targets");
await tools.bash({command:"sed -i 's/two/2/' "+file});
await rejects(()=>tools.replace({path:matches(two)[0],text:"X"}));
await tools.bash({command:"sed -i 's/three/3/' "+file});
await rejects(()=>tools.replace({path:file,start:three,text:"X\\n"}));`;
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
    const output = getToolResultText(run, "composed");
    expect(getToolExecution(run, "composed").isError, output).toBe(false);
    const [changedResult, changedAnchor, ...others] = failedCalls(output);
    expect(others, output).toEqual([]);
    expect(changedResult).toMatch(/^replace SEARCH#[A-F\d]+:1:match\n[\s\S]*(?:expired|stale)/u);
    expect(changedAnchor).toMatch(/^replace \.tmp\/shared\/main\.txt\n[\s\S]*stale/u);
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
check(after.text.includes("v_2 = renamed(a_2)")&&after.text.includes("v_109 = renamed(a_109)")&&after.text.includes("v_111 = renamed(a_111)"),"Targets were not applied at their new lines: "+after.text.slice(0,500));
// Two matches change their own text: one call names both and leaves the file untouched.
await tools.bash({command:"sed -i '116s/rename_me/x_me/;118s/rename_me/y_me/' "+file});
await rejects(()=>tools.replace({path:[r115,r117,r120],text:"renamed"}));
text("REFS "+JSON.stringify([r115,r117,r120]));`;
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
    const output = getToolResultText(run, "composed");
    expect(getToolExecution(run, "composed").isError, output).toBe(false);
    const [r115, r117, r120] = JSON.parse(
      /^REFS (\[.*\])$/mu.exec(output)?.[1] ?? "[]",
    ) as string[];
    const [failure, ...others] = failedCalls(output);
    expect(others, output).toEqual([]);
    // The first line names the call's sources; the reason below it names only unusable items.
    const reason = failure?.slice(failure.indexOf("\n") + 1) ?? "";
    expect(failure).toMatch(/^replace /u);
    expect(reason).toContain("2 of 3 references");
    expect(reason).toContain(r115);
    expect(reason).toContain(r117);
    expect(reason).not.toContain(r120);
  });
});

test("A list of match references from one search stays one target set when another session writes while the search registers them", async () => {
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
    const source = ".tmp/shared/main.cpp";
    const count = 200;
    const attempts = 12;
    const rows = Array.from({ length: count * 25 }, (_, index) => `int g_${String(index)} = 0;`);
    const row = (index: number, name: string) =>
      `int f_${String(index)}() { return ${name}(a_${String(index)}) + keep(a_${String(index)}); }`;
    for (let index = 0; index < count; index += 1) rows[index * 25] = row(index, "rename_me");
    await mkdir(path.join(cwd, ".tmp/shared"), { recursive: true });
    await writeFile(path.join(cwd, source), `${rows.join("\n")}\n`);
    // Each attempt searches while another session inserts one line above after a growing delay,
    // then renames a subset of the matches by number, like the recorded agent, with no further
    // write in between. Some writes land while the search registers its matches.
    const code =
      textResultChecks +
      String.raw`
const file=${JSON.stringify(source)};
const names=Array.from({length:${String(count)}},()=>"rename_me");
let anchored=0;
for(let attempt=0;attempt<${String(attempts)};attempt++){
  const [found]=await Promise.all([
    tools.search({path:file,query:"regex:\\b(?:rename_me|step_\\d\\d)\\b",limit:1000}).then((value)=>String(value.result)),
    tools.bash({command:"sleep "+(attempt*0.01).toFixed(2)+"; sed -i '1i // writer "+attempt+"' "+file}),
  ]);
  const heading=/SEARCH#([A-F\d]+):all:match/.exec(found);
  if(heading===null) continue;
  const next="step_"+String(attempt).padStart(2,"0");
  const chosen=names.flatMap((_,row)=>(row+attempt)%3===0?[]:[{row,ref:"SEARCH#"+heading[1]+":"+(row+1)+":match"}]);
  await tools.replace({path:chosen.map((item)=>item.ref),text:next});
  for(const item of chosen) names[item.row]=next;
  anchored++;
}
check(anchored>=4,"Only "+anchored+" searches registered their matches");
text("NAMES "+JSON.stringify(names));`;
    const run = await new PiIntegrationTest({
      testName: "anchors-list-registered-during-write",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      timeoutMs: 90_000,
      traceToolDetails: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["write", "read", "search", "replace", "bash", "codemode"],
      conversation: [
        assistantMessage([toolCall({ id: "composed", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Renamed.")]),
      ],
    }).run("Rename a subset of a search's matches while another session writes the file");
    const output = getToolResultText(run, "composed");
    expect(getToolExecution(run, "composed").isError, output).toBe(false);
    const names = JSON.parse(/NAMES (\[.*\])/u.exec(output)?.[1] ?? "[]") as string[];
    expect(names).toHaveLength(count);
    const writerLines = Array.from(
      { length: attempts },
      (_, index) => `// writer ${String(attempts - 1 - index)}`,
    );
    for (const [index, name] of names.entries()) rows[index * 25] = row(index, name);
    expect(await readFile(path.join(cwd, source), "utf8")).toBe(
      `${[...writerLines, ...rows].join("\n")}\n`,
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
const anchored=(await tools.read({path:file,views:["anchors"]})).text;
const rows=anchored.split("\\n").filter((row)=>/^[0-9A-HJKMNP-TV-Z]{7}\\|/.test(row)).map((row)=>{const at=row.indexOf("|"); return {anchor:row.slice(0,at), text:row.slice(at+1)};});
const closes=rows.filter((row)=>row.text==="}");
check(new Set(rows.map((row)=>row.anchor)).size===rows.length,"Two lines share an anchor");
const secondTemplate=rows.filter((row)=>row.text==="template <typename T>")[1].anchor;
const secondClose=closes[1].anchor;
// Another session inserts a repeated line and a new line above the whole file.
await tools.bash({command:"sed -i '1i }' "+file+" && sed -i '1i zero' "+file});
await tools.delete({path:file,start:secondTemplate,end:secondClose});
const after=(await tools.read({path:file})).text;
check(!after.includes("T b(T v)") && after.includes("T a(T v)") && after.includes("T c(T v)"),"The wrong block was deleted: "+after);
check(after.startsWith("zero\\n}\\n// a"),"Lines above changed: "+after);
// A changed landmark makes the anchors of its repeated lines stale.
await tools.bash({command:"sed -i 's|// c|// C|' "+file});
const thirdTemplate=rows.filter((row)=>row.text==="template <typename T>")[2].anchor;
await rejects(()=>tools.delete({path:file,start:thirdTemplate}));`;
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
    const output = getToolResultText(run, "composed");
    expect(getToolExecution(run, "composed").isError, output).toBe(false);
    const [stale, ...others] = failedCalls(output);
    expect(others, output).toEqual([]);
    expect(stale).toMatch(/^delete \.tmp\/shared\/repeated\.cpp\n[\s\S]*stale/u);
    expect(await readFile(path.join(cwd, source), "utf8")).toBe(
      "zero\n}\n// a\ntemplate <typename T>\nT a(T v) {\n  return v;\n}\n// b\n// C\ntemplate <typename T>\nT c(T v) {\n  return v;\n}\n",
    );
  });
});
