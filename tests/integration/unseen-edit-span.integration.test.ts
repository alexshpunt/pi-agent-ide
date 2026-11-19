import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolExecutions,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { textResultChecks } from "#integration/support/text-result-checks.ts";

const source = "main.cpp";
const begin = "static float funcStbirLinearToSrgbOp(float f)";
const end = "static stbir_uint8_t stbirLinearToSrgbUcharFn(float PIn)";
const original = [
  begin,
  ...Array.from({ length: 20_000 }, (_, index) =>
    index % 1000 === 0 ? "#pragma endregion" : `int peer_${index};`,
  ),
  "};",
  "",
  end,
  "",
].join("\n");

async function runCase(name: string, script: string, expected = original) {
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
    await writeFile(path.join(cwd, source), original);
    const code =
      textResultChecks +
      `\nconst file=${JSON.stringify(source)}, begin=${JSON.stringify(begin)}, end=${JSON.stringify(end)};\n` +
      script;
    const run = await new PiIntegrationTest({
      testName: name,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "replace", "delete", "copy", "move", "codemode"],
      conversation: [
        assistantMessage([toolCall({ id: "edit", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done.")]),
      ],
    }).run("Edit the selected C++ text");
    expect(getToolExecution(run, "edit").isError, getToolResultText(run, "edit")).toBe(false);
    if (expected === original) {
      const failures = getToolExecutions(run).filter((execution) => execution.isError);
      expect(failures).toHaveLength(1);
      expect(failures.map(getToolExecutionDetails)).toMatchObject([
        { results: [{ data: { errors: [{ code: "UNSEEN_EDIT_SPAN" }] } }] },
      ]);
    }
    expect(await readFile(path.join(cwd, source), "utf8")).toBe(expected);
  });
}

test("a truncated direct Read does not expose the unreturned middle of a file", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, source), original);
    const call = (name: string, id: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: { path: source, ...args } })], {
        stopReason: "toolUse",
      });
    const run = await new PiIntegrationTest({
      testName: "unseen-truncated-direct-read",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read", "replace"],
      conversation: [
        call("read", "head", {}),
        call("read", "tail", { offset: 20002, limit: 3 }),
        call("replace", "edit", { start: begin, end, newText: "short replacement" }),
        assistantMessage([text("Done.")]),
      ],
    }).run("Edit the selected C++ text");
    expect(getToolResultText(run, "head")).toContain(begin);
    expect(getToolResultText(run, "head")).not.toContain("int peer_15000;");
    expect(getToolResultText(run, "tail")).toContain(end);
    const edit = getToolExecution(run, "edit");
    expect(edit.isError).toBe(true);
    expect(getToolExecutionDetails(edit)).toMatchObject({
      results: [{ data: { errors: [{ code: "UNSEEN_EDIT_SPAN" }] } }],
    });
    expect(await readFile(path.join(cwd, source), "utf8")).toBe(original);
  });
});

test.each([true, false])("multi-path Read coverage (truncated: %s)", async (truncated) => {
  await withTempWorkspace(async (cwd) => {
    const lines = [begin, ...Array.from({ length: 299 }, (_, i) => `int part_${i};`), end];
    const content = `${lines.join("\n")}\n`;
    const prefixes = ["a.txt", "b.txt", "c.txt"];
    for (const file of prefixes) {
      const padding = Array.from(
        { length: truncated ? 450 : 1 },
        (_, i) => `${file} ${i} ${"padding ".repeat(11)}`,
      );
      await writeFile(path.join(cwd, file), `${padding.join("\n")}\n`);
    }
    await writeFile(path.join(cwd, source), content);
    const call = (name: string, id: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
    const run = await new PiIntegrationTest({
      testName: truncated ? "unseen-truncated-list-read" : "observed-list-read",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read", "replace"],
      conversation: [
        call("read", "files", { path: [...prefixes, source] }),
        call("replace", "edit", { path: source, start: begin, end, newText: "int updated;" }),
        assistantMessage([text("Done.")]),
      ],
    }).run("Replace the selected C++ text");
    expect(getToolExecution(run, "files").isError).toBe(false);
    expect(getToolResultText(run, "files").includes("int part_250;")).toBe(!truncated);
    const edit = getToolExecution(run, "edit");
    expect(edit.isError, getToolResultText(run, "edit")).toBe(truncated);
    if (truncated) {
      expect(getToolExecutionDetails(edit)).toMatchObject({
        results: [{ data: { errors: [{ code: "UNSEEN_EDIT_SPAN" }] } }],
      });
    }
    expect(await readFile(path.join(cwd, source), "utf8")).toBe(
      truncated ? content : "int updated;\n",
    );
  });
});

test.each([
  { truncated: true, count: 500, padding: 44 },
  { truncated: false, count: 301, padding: 1 },
])("direct Search coverage (truncated: $truncated)", async ({ truncated, count, padding }) => {
  await withTempWorkspace(async (cwd) => {
    const lines = Array.from(
      { length: count },
      (_, index) => `int hit_${String(index).padStart(3, "0")} = ${"1 + ".repeat(padding)}0;`,
    );
    const content = `${lines.join("\n")}\n`;
    await writeFile(path.join(cwd, source), content);
    const call = (name: string, id: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: { path: source, ...args } })], {
        stopReason: "toolUse",
      });
    const run = await new PiIntegrationTest({
      testName: truncated ? "unseen-truncated-direct-search" : "observed-direct-search",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["search", "replace"],
      conversation: [
        call("search", "hits", { query: "regex:^int hit_.*$", limit: lines.length }),
        call("replace", "edit", { start: lines[0], end: lines.at(-1), newText: "int updated;" }),
        assistantMessage([text("Done.")]),
      ],
    }).run("Replace the selected C++ text");
    const shown = getToolResultText(run, "hits");
    expect(shown).toContain(lines[0]);
    expect(shown.includes(lines[count - 1] ?? "")).toBe(!truncated);
    const edit = getToolExecution(run, "edit");
    expect(edit.isError, getToolResultText(run, "edit")).toBe(truncated);
    if (truncated) {
      expect(getToolExecutionDetails(edit)).toMatchObject({
        results: [{ data: { errors: [{ code: "UNSEEN_EDIT_SPAN" }] } }],
      });
    }
    expect(await readFile(path.join(cwd, source), "utf8")).toBe(
      truncated ? content : "int updated;\n",
    );
  });
});

test("the visible edit receipt covers the next wide selection without a Read", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, source), original);
    const inserted = Array.from({ length: 301 }, (_, i) => `int receipt_${i};`);
    const replace = (id: string, args: { start: string; end?: string; newText: string }) =>
      assistantMessage([toolCall({ id, name: "replace", arguments: { path: source, ...args } })], {
        stopReason: "toolUse",
      });
    const run = await new PiIntegrationTest({
      testName: "observed-edit-receipt",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["replace"],
      conversation: [
        replace("expand", { start: begin, newText: inserted.join("\n") }),
        replace("collapse", {
          start: "int receipt_0;",
          end: "int receipt_300;",
          text: "int collapsed;",
        }),
        assistantMessage([text("Done.")]),
      ],
    }).run("Replace the selected C++ text");
    expect(getToolResultText(run, "expand")).toContain(inserted.join("\n"));
    expect(getToolExecution(run, "collapse").isError, getToolResultText(run, "collapse")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, source), "utf8")).toBe(
      original.replace(begin, "int collapsed;"),
    );
  });
});

test("unique literal endpoints cannot replace twenty thousand unseen lines", async () => {
  await runCase(
    "unseen-literal-endpoints",
    String.raw`
await tools.read({path:file,offset:1,limit:2});
await tools.read({path:file,offset:20002,limit:3});
await rejects(()=>tools.replace({path:file,start:begin,end:"};\n\n"+end,newText:"short replacement"}));`,
  );
});

test("line endpoints from different searches cannot delete the unseen middle", async () => {
  await runCase(
    "unseen-search-endpoints",
    String.raw`
const a=(await tools.search({path:file,query:begin})).matches[0].id;
const b=(await tools.search({path:file,query:end})).matches[0].id;
await rejects(()=>tools.delete({path:file,start:a.replace(/:match$/,":line"),end:b.replace(/:match$/,":line")}));`,
  );
});

test.each(["copy", "move"] as const)("%s refuses an unseen destination range", async (tool) => {
  await runCase(
    `unseen-${tool}-destination`,
    `await tools.read({path:file,offset:1,limit:2});
await tools.read({path:file,offset:20001,limit:4});
await rejects(()=>tools.${tool}({path:file,start:"int peer_1;",target:file,targetStart:"int peer_1999;",targetEnd:end}));`,
  );
});

test("a multiline search result shown to a script authorizes the observed span", async () => {
  await runCase(
    "observed-script-search-span",
    String.raw`
const hit=(await tools.search({path:file,query:"regex:static float[^\\n]*\\n(?:[^\\n]*\\n){299}int peer_299;",multiline:true})).matches[0];
check(hit?.text.includes("int peer_299;"),"Search did not return the full match");
const result=await tools.replace({path:file,start:begin,end:"int peer_299;",newText:"updated"});
check(result!==null,"Observed span was refused");`,
    "updated\n" + original.split("\n").slice(301).join("\n"),
  );
});

test("paged reads authorize a wide edit without observing the rest of the file", async () => {
  await runCase(
    "observed-paged-span",
    String.raw`
await tools.read({path:file,offset:1,limit:150});
await tools.read({path:file,offset:151,limit:151});
const result=await tools.replace({path:file,start:begin,end:"int peer_299;",newText:"updated"});
check(result!==null,"Observed span was refused");`,
    "updated\n" + original.split("\n").slice(301).join("\n"),
  );
});

test("whole lines from individual search hits cover the selected span", async () => {
  await runCase(
    "observed-whole-search-lines",
    String.raw`
const shown=await tools.search({path:file,query:"regex:^(?:static float.*|#pragma endregion|int peer_(?:[0-9]|[12][0-9]?[0-9]?|[3-9][0-9]);)$"});
check(shown.matches[300]?.lineText==="int peer_299;","Search did not return the containing lines");
const result=await tools.replace({path:file,start:begin,end:"int peer_299;",newText:"updated"});
check(result!==null,"Observed span was refused");`,
    "updated\n" + original.split("\n").slice(301).join("\n"),
  );
});
