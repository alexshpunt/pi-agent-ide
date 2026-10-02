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

async function runComposition(
  cwd: string,
  name: string,
  scripts: readonly string[],
  extraExtensions: readonly string[] = [],
) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({ codemode: { mode: "on" } }),
  );
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: false,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode", ...extraExtensions],
    tools: ["read", "search", "replace", "write", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [toolCall({ id: `compose-${index}`, name: "codemode", arguments: { code } })],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("Composition finished.")]),
    ],
  }).run("Compose ordinary tools through source-aware results without rebuilding coordinates");
}

test("searches only a Read window and replaces a JS-selected match", async () => {
  await withTempWorkspace(async (cwd) => {
    const before = "old outside\r\n😀 old first\r\nold second\r\nold outside";
    await writeFile(path.join(cwd, "scope.txt"), before);
    const run = await runComposition(cwd, "read-search-replace-window", [
      `const read = await tools.read({path:"scope.txt",offset:2,limit:2});
if (read.status !== "success") throw Error(JSON.stringify(read.errors));
const found = await tools.search({path:read,query:"old"});
if (found.status !== "success") throw Error(JSON.stringify(found.errors));
if (found.data.matches.length !== 2) throw Error("Search escaped the read window");
text({scope:read.data.target,matches:found.data.matches});
const changed = await tools.replace({path:found.data.matches.slice(0,1),text:"NEW"});
if (changed.status !== "success") throw Error(JSON.stringify(changed.errors));
text(changed);`,
    ]);
    const shown = getToolResultText(run, "compose-0");
    expect(getToolExecution(run, "compose-0").isError, shown).toBe(false);
    expect(await readFile(path.join(cwd, "scope.txt"), "utf8")).toBe(
      "old outside\r\n😀 NEW first\r\nold second\r\nold outside",
    );
    expect(shown).toContain('"startColumn":3');
    expect(run.tuiRenderedOutput).toContain("scope.txt");
    expect(run.tuiRenderedOutput).toContain("Composition finished.");
  });
});

test("preserves sparse and multi-file scopes when refining results", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "a.txt"), "old one\nold GAP\nold two\n");
    await writeFile(path.join(cwd, "b.txt"), "old three\nold outside\n");
    const run = await runComposition(cwd, "sparse-multi-file-composition", [
      `const a = await tools.search({path:"a.txt",query:"regex:old (one|two)"});
const b = await tools.read({path:"b.txt",limit:1});
const refined = await tools.search({path:[a,b],query:"old"});
if (refined.status !== "success" || refined.data.matches.length !== 3) throw Error(JSON.stringify(refined));
const duplicate = [...refined.data.matches,refined.data.matches[0]];
text(await tools.replace({path:duplicate,text:"NEW"}));`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("NEW one\nold GAP\nNEW two\n");
    expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("NEW three\nold outside\n");
  });
});

test("retains complete targets beyond both Read and Search previews", async () => {
  await withTempWorkspace(async (cwd) => {
    const before = "old\n".repeat(2101);
    await writeFile(path.join(cwd, "large.txt"), before);
    const run = await runComposition(cwd, "composition-preview-is-not-scope", [
      `const read = await tools.read({path:"large.txt"});
if (!read.data.truncated) throw Error("Expected a bounded Read preview");
const found = await tools.search({path:read,query:"old",limit:1});
if (found.status !== "success" || !found.data.truncated || found.data.matches.length !== 100) throw Error("Expected a bounded Search preview");
store("completeSelection",found); text({readPreview:read.data.lines.length,searchPreview:found.data.matches.length});`,
      `const changed = await tools.replace({path:load("completeSelection"),text:"NEW"});
if (changed.status !== "success") throw Error(JSON.stringify(changed.errors)); text(changed);`,
    ]);
    for (const id of ["compose-0", "compose-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(await readFile(path.join(cwd, "large.txt"), "utf8")).toBe("NEW\n".repeat(2101));
  });
});

test("rejects stale structured targets without changing legacy all-selection refresh", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "stale.txt"), "old original\n");
    const run = await runComposition(cwd, "composition-strict-versus-search-refresh", [
      `const found = await tools.search({path:"stale.txt",query:"old"}); store("oldSelection",found);
text(await tools.write({path:"stale.txt",content:"old updated old\\n"}));`,
      `const found = load("oldSelection");
const stale = await tools.replace({path:found,text:"WRONG"});
if (stale.status !== "error" || stale.data.effect !== "not-applied") throw Error("Stale result was not safely rejected");
text(stale);
const current = await tools.read({path:"stale.txt"});
if (current.data.lines[0].content !== "old updated old") throw Error("Stale edit wrote source bytes");
text(await tools.replace({path:found.data.all.match,text:"NEW"}));`,
    ]);
    for (const id of ["compose-0", "compose-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(await readFile(path.join(cwd, "stale.txt"), "utf8")).toBe("NEW updated NEW\n");
    expect(getToolResultText(run, "compose-1")).toContain("stale");
  });
});

test("keeps empty results distinct from unsupported or forged source data", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "empty.txt"), "safe\n");
    const run = await runComposition(cwd, "composition-empty-and-unsupported", [
      `const empty = await tools.search({path:"empty.txt",query:"absent"});
const nothing = await tools.replace({path:empty,text:"WRONG"});
if (nothing.status !== "success") throw Error("Empty targets should be a successful no-op");
const emptyScope = await tools.search({path:[],query:"safe"});
if (emptyScope.status !== "success" || emptyScope.data.matches.length !== 0) throw Error("Empty array widened to cwd");
for (const input of [{kind:"text",source:"empty.txt",lines:[{content:"safe"}]},{target:"RESULT#forged"},"RESULT#expired",{status:"partial",data:empty.data}]) {
const rejected = await tools.replace({path:input,text:"WRONG"});
if (rejected.status !== "error" || rejected.data.effect !== "not-applied") throw Error("Unsupported input gained write authority");
}
text(nothing);`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "empty.txt"), "utf8")).toBe("safe\n");
    expect(run.tuiRenderedOutput).toContain("No changes · empty target set");
  });
});

test("preserves zero-width source positions for replacement", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "position.txt"), "keep\n😀 body\n");
    const run = await runComposition(cwd, "composition-zero-width-target", [
      `const read = await tools.read({path:"position.txt",offset:2,limit:1});
const found = await tools.search({path:read,query:"regex:^"});
if (found.status !== "success" || found.data.matches.length !== 1 || found.data.matches[0].range.endColumn !== 0) throw Error("Lost zero-width target");
text(await tools.replace({path:found.data,text:"prefix "}));`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "position.txt"), "utf8")).toBe("keep\nprefix 😀 body\n");
  });
});

test("preserves the editor write guard for structured inputs", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "guard.txt"), "old original\n");
    const run = await runComposition(
      cwd,
      "composition-write-guard",
      [
        `const read = await tools.read({path:"guard.txt"});
const found = await tools.search({path:read,query:"old"});
const rejected = await tools.replace({path:found,text:"GUARDED"});
if (rejected.status !== "error" || rejected.data.effect !== "not-applied") throw Error("Structured targets bypassed the write guard");
text(rejected);`,
      ],
      [path.resolve("tests/integration/support/native-text-edit-probe.ts")],
    );
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "guard.txt"), "utf8")).toBe("old original\n");
    const events = (await readFile(path.join(cwd, "batch-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type === "guard")).toHaveLength(1);
    expect(events.filter((event) => event.type === "edit")).toHaveLength(0);
  });
});
