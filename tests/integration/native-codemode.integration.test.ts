import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
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
import { expect, test } from "vitest";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const initial = "alpha\nbeta\ngamma\nomega\n";

test.each([
  ["read", "all"],
  ["read", "allSettled"],
  ["search", "all"],
  ["search", "allSettled"],
] as const)(
  "concurrent %s result edits share one batch through Promise.%s",
  async (source, method) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "insert.txt"), "first\nmiddle\nlast\n");
      await writeFile(path.join(cwd, "delete.txt"), "one\ntwo\nthree\n");
      const acquire = (file: string) =>
        source === "read"
          ? `tools.read({path:${JSON.stringify(file)},views:["anchors"]})`
          : `tools.search({path:${JSON.stringify(file)},query:"regex:.+"})`;
      const run = await runScripts(cwd, `shared-result-${source}-${method}`, [
        `const ins = await ${acquire("insert.txt")};
const del = await ${acquire("delete.txt")};
const results = await Promise.${method}([
  tools.insert({path:ins,after:${JSON.stringify(anchor(1, "first"))},text:"FIRST\\n"}),
  tools.insert({path:ins,after:${JSON.stringify(anchor(2, "middle"))},text:"MIDDLE\\n"}),
  tools.insert({path:"./insert.txt",after:${JSON.stringify(anchor(3, "last"))},text:"LAST\\n"}),
  tools.delete({path:del,at:${JSON.stringify(anchor(1, "one"))}}),
  tools.delete({path:del,at:${JSON.stringify(anchor(2, "two"))}}),
  tools.delete({path:"./delete.txt",at:${JSON.stringify(anchor(3, "three"))}}),
]);
${method === "allSettled" ? 'if (results.some(result => result.status !== "fulfilled") || results.slice(0,3).some(result => result.value === null)) throw Error("Concurrent edit failed");' : 'if (results.slice(0,3).some(result => result === null)) throw Error("Concurrent edit failed");'}`,
      ]);
      expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
        false,
      );
      expect(codemodeFailures(getToolResultText(run, "script-0"))).toBe("");
      expect(batchDetails(run).editorBatches.map((batch) => batch.calls.length)).toEqual([6]);
      expect(await readFile(path.join(cwd, "insert.txt"), "utf8")).toBe(
        "first\nFIRST\nmiddle\nMIDDLE\nlast\nLAST\n",
      );
      expect(await readFile(path.join(cwd, "delete.txt"), "utf8")).toBe("");
    });
  },
);

test.each(["inside", "outside", "changed"] as const)(
  "native Read selection retains its scope when the target is %s",
  async (scenario) => {
    await withTempWorkspace(async (cwd) => {
      const content = "alpha\nbeta\ngamma\nomega\n";
      await writeFile(path.join(cwd, "note.txt"), content);
      const run = await runScripts(cwd, "native-read-scope-" + scenario, [
        `const found = await tools.read({path:"note.txt",offset:2,limit:2,views:["anchors"]});
await tools.insert({path:"note.txt",before:"alpha",text:"added\\n"});
const result = await tools.replace({path:found,at:${JSON.stringify(scenario === "outside" ? "omega" : scenario === "changed" ? "gamma" : "beta")},text:${JSON.stringify(scenario === "changed" ? "RACE_REMOVE_GAMMA" : "BETA")}});
if (${scenario === "outside" ? "result !== null" : "result === null"}) throw Error("Unexpected scoped edit result");`,
      ]);
      const failed = scenario === "changed";
      expect(getToolExecution(run, "script-0").isError).toBe(failed);
      expect(
        batchDetails(run).editorBatches.map((batch) => batch.calls.map((call) => call.state)),
      ).toEqual([
        scenario === "outside"
          ? ["completed"]
          : ["completed", failed ? "failed-not-applied" : "completed"],
      ]);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
        scenario === "inside"
          ? "added\nalpha\nBETA\ngamma\nomega\n"
          : failed
            ? "added\nalpha\nbeta\nomega\n"
            : "added\n" + content,
      );
    });
  },
);
test.each(["value", "match", "numbered"] as const)(
  "native Search %s source scopes explicit anchors without broadening them",
  async (selection) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta tail\nother tail\ngamma\nomega\n");
      const selected =
        selection === "value"
          ? "found"
          : selection === "match"
            ? "found.matches[0]"
            : '"SEARCH#"+session+":1:line"';
      const run = await runScripts(cwd, "native-search-scoped-" + selection, [
        `const found = await tools.search({path:"note.txt",query:"beta tail"});
const session = (await tools.read({path:"search-selection.txt"})).text.match(/SEARCH#([A-Fa-f0-9]+):/)[1];
await tools.insert({path:"note.txt",before:"alpha",text:"added\\n"});
await tools.replace({path:${selected},at:"tail",text:"TAIL"});
await tools.delete({path:"note.txt",at:"gamma\\n"});`,
      ]);
      expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
        false,
      );
      expect(batchDetails(run).editorBatches.map((batch) => batch.calls.length)).toEqual([3]);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
        "added\nalpha\nbeta TAIL\nother tail\nomega\n",
      );
    });
  },
);

test.each(["outside", "separate-ranges"] as const)(
  "native Search source rejects explicit anchors %s its scope",
  async (scenario) => {
    await withTempWorkspace(async (cwd) => {
      const content = "alpha\nbeta\nunselected\ngamma\nomega\n";
      await writeFile(path.join(cwd, "note.txt"), content);
      const run = await runScripts(cwd, "native-search-scope-rejection-" + scenario, [
        `const found = await tools.search({path:"note.txt",query:${JSON.stringify(scenario === "outside" ? "beta" : "regex:beta|gamma")}});
await tools.insert({path:"note.txt",before:"alpha",text:"added\\n"});
const rejected = await tools.replace({path:found,${scenario === "outside" ? 'at:"gamma"' : 'from:"beta",through:"gamma"'},text:"WRONG"});
if (rejected !== null) throw Error("Source scope was broadened");`,
      ]);
      expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
        false,
      );
      expect(batchDetails(run).editorBatches.map((batch) => batch.calls.length)).toEqual([1]);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("added\n" + content);
    });
  },
);
test.each(["value-source", "match-source", "match-anchor", "id-anchor"] as const)(
  "native Search %s values share a local edit batch",
  async (selection) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), initial);
      const argument =
        selection === "value-source"
          ? "path: found"
          : selection === "match-source"
            ? "path: found.matches[0]"
            : selection === "match-anchor"
              ? "at: found.matches[0]"
              : "at: found.matches[0].id";
      const run = await runScripts(cwd, "native-search-value-" + selection, [
        `const found = await tools.search({path:"note.txt",query:"beta"});
await tools.insert({path:"note.txt",before:"alpha",text:"added\\n"});
await tools.replace({${argument},text:"BETA"});
await tools.delete({path:"note.txt",at:"gamma\\n"});`,
      ]);
      expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
        false,
      );
      expect(batchDetails(run).editorBatches.map((batch) => batch.calls.length)).toEqual([3]);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
        "added\nalpha\nBETA\nomega\n",
      );
      expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(1);
    });
  },
);

test.each(["RACE_PREPEND", "RACE_REMOVE_GAMMA"] as const)(
  "native Search values replan after %s without replaying peers",
  async (race) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), initial);
      const run = await runScripts(cwd, "native-search-value-" + race, [
        `const found = await tools.search({path:"note.txt",query:"regex:beta|gamma"});
await tools.replace({path:found.matches[1],text:${JSON.stringify(race)}});
await tools.replace({at:found.matches[0],text:"BETA"});
await tools.replace({path:"note.txt",at:"omega",text:"OMEGA"});`,
      ]);
      const removed = race === "RACE_REMOVE_GAMMA";
      expect(getToolExecution(run, "script-0").isError).toBe(removed);
      expect(
        batchDetails(run).editorBatches.map((batch) => batch.calls.map((call) => call.state)),
      ).toEqual([[removed ? "failed-not-applied" : "completed", "completed", "completed"]]);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
        removed ? "alpha\nBETA\nOMEGA\n" : "external\nalpha\nBETA\nRACE_PREPEND\nOMEGA\n",
      );
      expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(1);
    });
  },
);

test("a pending edit result used as an anchor remains a commit boundary", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-pending-result-anchor", [
      `const changed = await tools.replace({path:"note.txt",at:"beta",text:"BETA"});
await tools.replace({path:"note.txt",at:changed,text:"FINAL"});
await tools.replace({path:"note.txt",at:"gamma",text:"GAMMA"});`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(batchDetails(run).editorBatches.map((batch) => batch.calls.length)).toEqual([1, 1]);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nFINAL\nGAMMA\nomega\n");
  });
});
test("a Search all selection cannot silently expand outside its accepted batch source", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "a.txt"), "alpha\nbeta\n");
    await writeFile(path.join(cwd, "b.txt"), "none\n");
    const run = await runScripts(cwd, "native-search-expanded-source", [
      searchRefs("session", ["a.txt", "b.txt"], "beta") +
        `
await tools.replace({at:"SEARCH#"+session+":all:line",text:"RACE_EXPAND"});
await tools.replace({path:"a.txt",at:"alpha",text:"ALPHA"});`,
    ]);
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    expect(
      batchDetails(run).editorBatches.map((batch) => batch.calls.map((call) => call.state)),
    ).toEqual([["failed-not-applied", "completed"]]);
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("external\nALPHA\nbeta\n");
    expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("beta\n");
  });
});
test("the paid Search fixture works without a project config directory", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await new PiIntegrationTest({
      testName: "native-search-paid-fixture",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("benchmarks/tool-capabilities/native-search-batch-fixture.ts"),
      ],
      tools,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "script-0",
              name: "codemode",
              arguments: {
                code: `await tools.search({path:"note.txt",query:"beta"});
const shown = (await tools.read({path:".pi/issued-search.txt"})).text;
const session = shown.match(/SEARCH#([A-Fa-f0-9]+):/)[1];
await tools.insert({path:"note.txt",before:"alpha",text:"added\\n"});
await tools.replace({at:"SEARCH#"+session+":1:line",text:"BETA\\n"});
await tools.delete({path:"note.txt",at:"gamma\\n"});`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Edit using the issued Search selection");
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(batchDetails(run).editorBatches.map((batch) => batch.calls.length)).toEqual([3]);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("added\nalpha\nBETA\nomega\n");
  });
});

test.each(["numbered", "numbered-path", "all", "all-path"] as const)(
  "local Search %s selections share a native edit batch",
  async (selection) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), initial);
      const run = await runScripts(cwd, `native-search-batch-${selection}`, [
        `const found = await tools.search({path:"note.txt",query:"beta"});
// Search's script projection returns RESULT ids. Read the probe's unchanged public
// Search output to exercise the SEARCH selectors a caller can already hold.
const shown = (await tools.read({path:"search-selection.txt"})).text;
const session = shown.match(/SEARCH#([A-Fa-f0-9]+):/)[1];
const selected = "SEARCH#" + session + ${selection.startsWith("all") ? '":all:line"' : '":1:line"'};
await tools.insert({path:"note.txt",before:"alpha",text:"added\\n"});
await tools.replace(${selection.endsWith("-path") ? '{path:selected,text:"BETA\\n"}' : '{at:selected,text:"BETA\\n"}'});
await tools.delete({path:"note.txt",at:"gamma\\n"});`,
      ]);
      expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
        false,
      );
      expect(batchDetails(run).editorBatches.map((batch) => batch.calls.length)).toEqual([3]);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
        "added\nalpha\nBETA\nomega\n",
      );
      expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(1);
    });
  },
);

/** Script projections intentionally hide SEARCH selectors; retain the actual public output. */
const searchRefs = (name: string, source: string | readonly string[], query: string) => `
await tools.search({path:${JSON.stringify(source)},query:${JSON.stringify(query)}});
const ${name} = (await tools.read({path:"search-selection.txt"})).text.match(/SEARCH#([A-Fa-f0-9]+):/)[1];
`;

test("local Search anchors infer every source field instead of the last Read", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    await writeFile(path.join(cwd, "dest.txt"), "head\ntail\n");
    const run = await runScripts(cwd, "native-search-transfer", [
      searchRefs("src", "note.txt", "regex:beta|gamma") +
        searchRefs("dst", "dest.txt", "regex:head|tail") +
        `
await tools.copy({at:"SEARCH#"+src+":1:line",targetAfter:"SEARCH#"+dst+":1:line"});
await tools.move({at:"SEARCH#"+src+":2:line",targetAfter:"SEARCH#"+dst+":2:line"});
await tools.insert({before:"SEARCH#"+src+":1:match",text:"prefix "});
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(batchDetails(run).editorBatches.map((batch) => batch.calls.length)).toEqual([3]);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nprefix beta\nomega\n");
    expect(await readFile(path.join(cwd, "dest.txt"), "utf8")).toBe("head\nbeta\ntail\ngamma\n");
    expect((await events(cwd)).filter((event) => event.type === "guard")).toHaveLength(1);
  });
});

test.each(["RACE_PREPEND", "RACE_REMOVE_GAMMA"] as const)(
  "local Search batches replan after %s without replaying peers",
  async (race) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), initial);
      const run = await runScripts(cwd, "native-search-" + race, [
        searchRefs("session", "note.txt", "regex:beta|gamma") +
          `
await tools.replace({path:"note.txt",at:"SEARCH#"+session+":2:line",text:${JSON.stringify(`${race}\n`)}});
await tools.replace({at:"SEARCH#"+session+":1:line",text:"BETA\\n"});
await tools.replace({path:"note.txt",at:"omega",text:"OMEGA"});
`,
      ]);
      const removed = race === "RACE_REMOVE_GAMMA";
      expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
        removed,
      );
      expect(
        batchDetails(run).editorBatches.map((batch) => batch.calls.map((call) => call.state)),
      ).toEqual([[removed ? "failed-not-applied" : "completed", "completed", "completed"]]);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
        removed ? "alpha\nBETA\nOMEGA\n" : "external\nalpha\nBETA\nRACE_PREPEND\nOMEGA\n",
      );
      expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(1);
    });
  },
);

test("local Search typed sources retain their implicit selection alongside explicit anchors", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-search-source-union", [
      searchRefs("session", "note.txt", "beta") +
        `
await tools.insert({path:"note.txt",before:"alpha",text:"added\\n"});
// The beta line selection includes its LF, so the literal takes gamma's LF too.
await tools.replace({path:"SEARCH#"+session+":all:line",at:"gamma\\n",text:"changed\\n"});
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(batchDetails(run).editorBatches.map((batch) => batch.calls.length)).toEqual([2]);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
      "added\nalpha\nchanged\nchanged\nomega\n",
    );
  });
});

test("multi-file Search all selections remain a commit boundary", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "a.txt"), "alpha\nbeta\n");
    await writeFile(path.join(cwd, "b.txt"), "beta\n");
    const run = await runScripts(cwd, "native-search-multi-boundary", [
      searchRefs("session", ["a.txt", "b.txt"], "beta") +
        `
await tools.replace({path:"a.txt",at:"alpha",text:"ALPHA"});
await tools.replace({at:"SEARCH#"+session+":all:line",text:"BETA\\n"});
await tools.insert({path:"a.txt",before:"ALPHA",text:"added\\n"});
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(batchDetails(run).editorBatches.map((batch) => batch.calls.length)).toEqual([1, 1]);
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("added\nALPHA\nBETA\n");
    expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("BETA\n");
  });
});

test("a local Search anchor cannot redirect an explicit source", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    await writeFile(path.join(cwd, "other.txt"), "beta\n");
    const run = await runScripts(cwd, "native-search-wrong-source", [
      searchRefs("session", "note.txt", "beta") +
        `
await tools.replace({path:"note.txt",at:"alpha",text:"ALPHA"});
const rejected = await tools.replace({path:"other.txt",at:"SEARCH#"+session+":1:line",text:"wrong"});
if (rejected !== null) throw Error("mismatched source accepted");
await tools.replace({path:"note.txt",at:"omega",text:"OMEGA"});
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(batchDetails(run).editorBatches.map((batch) => batch.calls.length)).toEqual([2]);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("ALPHA\nbeta\ngamma\nOMEGA\n");
    expect(await readFile(path.join(cwd, "other.txt"), "utf8")).toBe("beta\n");
  });
});

const tools = [
  "read",
  "search",
  "insert",
  "replace",
  "delete",
  "copy",
  "move",
  "write",
  "codemode",
];
// Fixture lines are unique, so a line's anchor depends only on its text.
const anchor = (_line: number, text: string): string => formatLineHashAnchor(text, 1);

interface BatchEvent {
  type: string;
  name?: string;
  parent?: string;
  id?: string;
  content?: string;
  isError?: boolean;
  before?: string;
  after?: string;
}

async function events(cwd: string): Promise<BatchEvent[]> {
  return (await readFile(path.join(cwd, "batch-events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as BatchEvent);
}

async function runScripts(
  cwd: string,
  name: string,
  scripts: readonly string[],
  mode: "on" | "only" = "on",
  extraExtensions: readonly string[] = [],
  finish = true,
) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(path.join(cwd, ".pi/settings.json"), JSON.stringify({ codemode: { mode } }));
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: false,
    cwd,
    extensions: [
      path.resolve("src/pi-agent-ide.ts"),
      "builtin:codemode",
      path.resolve("tests/integration/support/native-text-edit-probe.ts"),
      ...extraExtensions,
    ],
    tools,
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [toolCall({ id: `script-${index}`, name: "codemode", arguments: { code } })],
          { stopReason: "toolUse" },
        ),
      ),
      ...(finish ? [assistantMessage([text("Done")])] : []),
    ],
  }).run("Use sequential native Codemode editor calls with guarded original-snapshot batches");
}

function batchDetails(run: Awaited<ReturnType<typeof runScripts>>, id = "script-0") {
  return getToolExecutionDetails(getToolExecution(run, id)) as {
    calls: { id: string; name: string; status: string }[];
    editorBatches: { applied: boolean; calls: { id: string; state: string }[] }[];
  };
}

test.each(["on", "only"] as const)(
  "Write saves and formats files before returning in Codemode %s",
  async (mode) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "existing.note"), "old\n");
      const run = await runScripts(
        cwd,
        `native-codemode-immediate-write-${mode}`,
        [
          'text(await tools.write({path:"new.note",content:"created\\n"}));\n' +
            'text(await tools.write({path:"existing.note",content:"replaced\\n"}));\n' +
            'throw new Error("after completed writes");',
        ],
        mode,
        [path.resolve("tests/integration/support/final-post-edit-extension.ts")],
      );
      expect(getToolExecution(run, "script-0").isError).toBe(true);
      expect(getToolResultText(run, "script-0")).toContain("after completed writes");
      const recorded = await events(cwd);
      expect(
        recorded
          .filter((event) => event.type === "result" && event.name === "write")
          .map((event) => event.content),
      ).toEqual(["CREATED\n", "REPLACED\n"]);
      expect(await readFile(path.join(cwd, "new.note"), "utf8")).toBe("CREATED\n");
      expect(await readFile(path.join(cwd, "existing.note"), "utf8")).toBe("REPLACED\n");
      expect(batchDetails(run).editorBatches).toHaveLength(0);
      expect(
        (await readFile(path.join(cwd, "format-events.jsonl"), "utf8")).trim().split("\n"),
      ).toHaveLength(2);
    });
  },
);

test("Write finishes pending edits and gives later edits its saved snapshot", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.note"), "alpha\nbeta\n");
    const run = await runScripts(
      cwd,
      "native-codemode-immediate-write-boundary",
      [
        'text(await tools.replace({path:"note.note",at:"alpha",text:"first"}));\n' +
          'text(await tools.write({path:"note.note",content:"replacement\\n"}));\n' +
          'text(await tools.replace({path:"note.note",at:"REPLACEMENT",text:"changed"}));',
      ],
      "on",
      [path.resolve("tests/integration/support/final-post-edit-extension.ts")],
    );
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    const recorded = await events(cwd);
    expect(
      recorded.find((event) => event.type === "result" && event.name === "write")?.content,
    ).toBe("REPLACEMENT\n");
    expect(recorded.filter((event) => event.type === "call").map((event) => event.content)).toEqual(
      ["alpha\nbeta\n", "first\nbeta\n", "REPLACEMENT\n"],
    );
    expect(await readFile(path.join(cwd, "note.note"), "utf8")).toBe("CHANGED\n");
    expect(batchDetails(run).editorBatches.map((batch) => batch.calls.length)).toEqual([1, 1]);
    const formats = (await readFile(path.join(cwd, "format-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { content: string });
    expect(formats.map((event) => event.content)).toEqual(["replacement\n", "changed\n"]);
  });
});

test("a completed Write survives a later script deadline", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await runScripts(cwd, "native-codemode-immediate-write-deadline", [
      '// @options: {"timeout_ms":2000}\ntext(await tools.write({path:"saved.txt",content:"saved\\n"})); while (true) {}',
    ]);
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    expect(
      (await events(cwd)).find((event) => event.type === "result" && event.name === "write")
        ?.content,
    ).toBe("saved\n");
    expect(await readFile(path.join(cwd, "saved.txt"), "utf8")).toBe("saved\n");
  });
});
test.each(["on", "only"] as const)(
  "native Codemode %s preserves original snapshots for sequential edits",
  async (mode) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), initial);
      const run = await runScripts(
        cwd,
        `native-codemode-sequential-${mode}`,
        [
          `text(await tools.read({path:"note.txt",views:["anchors"]}));
text(await tools.insert({path:"note.txt",before:${JSON.stringify(anchor(1, "alpha"))},text:"added\\n"}));
text(await tools.replace({at:${JSON.stringify(anchor(2, "beta"))},text:"BETA\\n"}));
text(await tools.delete({path:"note.txt",at:${JSON.stringify(anchor(3, "gamma"))}}));`,
        ],
        mode,
      );
      const shown = getToolResultText(run, "script-0");
      expect(getToolExecution(run, "script-0").isError, shown).toBe(false);
      expect(shown).toContain("Editor batches: 1 committed");
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
        "added\nalpha\nBETA\nomega\n",
      );
      const recorded = await events(cwd);
      expect(
        recorded
          .filter(
            (event) =>
              event.type === "call" && ["insert", "replace", "delete"].includes(event.name ?? ""),
          )
          .map((event) => event.content),
      ).toEqual([initial, initial, initial]);
      expect(recorded.filter((event) => event.type === "guard")).toHaveLength(1);
      expect(recorded.filter((event) => event.type === "edit")).toHaveLength(1);
      expect(recorded.filter((event) => event.type === "post-edit")).toHaveLength(1);
      const details = batchDetails(run);
      expect(details.editorBatches).toEqual([
        {
          applied: true,
          calls: [
            { id: "script-0/2", state: "completed" },
            { id: "script-0/3", state: "completed" },
            { id: "script-0/4", state: "completed" },
          ],
        },
      ]);
      expect(recorded.filter((event) => event.type === "result")).toHaveLength(4);
      expect(
        recorded
          .filter((event) => event.type === "call")
          .every((event) => event.parent === "script-0"),
      ).toBe(true);
      expect(details.calls.every((call) => call.status === "ok")).toBe(true);
    });
  },
);

test("editor batches commit automatically without a checkpoint tool", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-automatic-commits", [
      `if (ALL_TOOLS.some(tool => tool.name === "flush")) throw Error("Unexpected editor checkpoint tool");
await tools.replace({path:"note.txt",at:"alpha",text:"ALPHA"});
const shown = await tools.read({path:"note.txt"});
if (!shown.text.includes("ALPHA")) throw Error("Read did not see the committed edit");
const changed = await tools.replace({path:"note.txt",at:"beta",text:"BETA"});
await tools.replace({path:changed,text:"FINAL"});
text(await tools.replace({path:"note.txt",at:"gamma",text:"GAMMA"}));`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("ALPHA\nFINAL\nGAMMA\nomega\n");
  });
});
test("read and search finish a batch before dependent work starts", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-read-boundary", [
      `text(await tools.insert({path:"note.txt",before:${JSON.stringify(anchor(1, "alpha"))},text:"added\\n"}));
const shown = await tools.read({path:"note.txt",views:["anchors"]});
if (!shown.text.includes(${JSON.stringify(anchor(3, "beta"))})) throw new Error("read saw an uncommitted file");
text(await tools.replace({path:"note.txt",at:${JSON.stringify(anchor(3, "beta"))},text:"BETA\\n"}));
const found = await tools.search({path:"note.txt",query:"BETA"});
if (found.matches.length !== 1 || found.matches[0].line !== 3) throw new Error("search saw an uncommitted file: " + JSON.stringify(found));
text(JSON.stringify(found));`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(batchDetails(run).editorBatches).toHaveLength(2);
    expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(2);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
      "added\nalpha\nBETA\ngamma\nomega\n",
    );
    expect(getToolResultText(run, "script-0")).toMatch(/"id":"RESULT#[\da-f-]{36}"/u);
  });
});

test.each([
  {
    name: "script-error",
    tail: 'throw new Error("planned script error");',
    message: "planned script error",
  },
  {
    name: "timeout-words-in-script-error",
    tail: 'throw new Error("Script timed out: ordinary user error");',
    message: "ordinary user error",
  },
  {
    name: "stale-anchor",
    // The stale edit resolves to null; the script stops on it and its reason ends the result.
    tail: `if ((await tools.replace({path:"note.txt",at:${JSON.stringify(anchor(2, "wrong"))},text:"wrong"})) === null) throw new Error("stale edit failed");`,
    message: "is stale",
  },
  {
    name: "blocked-hook",
    tail: 'await tools.replace({path:"note.txt",at:"beta",text:"BLOCKED"});',
    message: "fixture blocked this edit",
  },
  {
    name: "malformed-arguments",
    tail: 'await tools.replace({path:"note.txt",at:{invalid:true},text:"wrong"});',
    message: 'Validation failed for tool "replace"',
  },
])("accepted edits survive $name without bypassing validation", async (scenario) => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, `native-codemode-${scenario.name}`, [
      `text(await tools.insert({path:"note.txt",before:${JSON.stringify(anchor(1, "alpha"))},text:"added\\n"}));\n${scenario.tail}`,
    ]);
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    expect(getToolResultText(run, "script-0")).toContain(scenario.message);
    expect(getToolResultText(run, "script-0")).toContain("Editor batches: 1 committed");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("added\n" + initial);
    expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(1);
  });
});

test("overlapping accepted-snapshot edits identify the destination range", async () => {
  await withTempWorkspace(async (cwd) => {
    const header = "untouched\n".repeat(20);
    await writeFile(path.join(cwd, "note.txt"), header + initial);
    const run = await runScripts(cwd, "native-codemode-overlap", [
      'await tools.replace({path:"note.txt",at:"alpha",text:"FIRST"}); text("second:" + (await tools.move({path:"note.txt",at:"gamma",targetFrom:"alpha",targetThrough:"alpha"})));',
    ]);
    const output = getToolResultText(run, "script-0");
    expect(getToolExecution(run, "script-0").isError, output).toBe(false);
    expect(output).toContain("second:null");
    const failure = codemodeFailures(output);
    expect(failure).toContain("targetFrom");
    expect(failure).toContain("targetThrough");
    expect(failure).toContain("replace");
    expect(failure).toMatch(/\b21\b/u);
    expect(failure).not.toContain("script-0/2");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
      header + "FIRST\nbeta\ngamma\nomega\n",
    );
  });
});

test.each(["empty", "large"] as const)(
  "move rejects the %s selector with a bounded result",
  async (kind) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), initial);
      const run = await runScripts(cwd, `native-codemode-rejected-start-${kind}`, [
        `const start = ${kind === "empty" ? '""' : '"SELECTOR_HEAD" + "\\\\t".repeat(180_000) + "SELECTOR_TAIL"'};
text("move:" + (await tools.move({path:"note.txt",at: start,targetAfter:"omega"}))); `,
      ]);
      const output = getToolResultText(run, "script-0");
      expect(output).toContain("move:null");
      expect(Buffer.byteLength(output)).toBeLessThan(2048);
      const failure = codemodeFailures(output);
      expect(failure).not.toContain(anchor(1, "alpha"));
      if (kind === "large") {
        expect(failure).toContain("SELECTOR_HEAD");
        expect(failure).toContain("SELECTOR_TAIL");
        expect(failure).toContain("360026");
      } else {
        expect(failure).toContain("EMPTY_SELECTOR");
      }
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(initial);
    });
  },
);

test("a rejected combined write fails the parent and blocks the next read", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-write-guard", [
      'text(await tools.replace({path:"note.txt",at:"alpha",text:"GUARDED"})); text(await tools.read({path:"note.txt"}));',
    ]);
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    const output = getToolResultText(run, "script-0");
    expect(output).toContain("fixture rejected the combined write");
    // The Read after the failed batch is refused in execution: it resolves to null and is listed.
    expect(codemodeFailures(output)).toContain(
      "- read note.txt\n  Editor batch failed before this tool.",
    );
    expect(batchDetails(run).editorBatches).toEqual([
      { applied: false, calls: [{ id: "script-0/1", state: "failed-not-applied" }] },
    ]);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(initial);
    const recorded = await events(cwd);
    expect(recorded.filter((event) => event.type === "guard")).toHaveLength(1);
    expect(recorded.filter((event) => event.type === "edit")).toHaveLength(0);
    expect(
      recorded
        .filter((event) => event.type === "result" && event.name === "read")
        .map((event) => event.isError),
    ).toEqual([true]);
  });
});

test("accepted edits are replanned on the text another writer changed", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-replan-external-change", [
      'text(await tools.replace({path:"note.txt",at:"alpha",text:"RACE_APPEND"}));' +
        'text(await tools.replace({path:"note.txt",at:"beta",text:"B"}));',
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(getToolResultText(run, "script-0")).toContain("Editor batches: 1 committed");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
      "RACE_APPEND\nB\ngamma\nomega\nexternal\n",
    );
    expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(1);
  });
});

test("a call whose anchor another writer removed fails alone at commit", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-replan-partial", [
      'text(await tools.replace({path:"note.txt",at:"gamma",text:"G"}));' +
        'text(await tools.replace({path:"note.txt",at:"beta",text:"RACE_REMOVE_GAMMA"}));',
    ]);
    const output = getToolResultText(run, "script-0");
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    expect(output).toContain("gamma");
    expect(batchDetails(run).editorBatches).toEqual([
      {
        applied: true,
        calls: [
          { id: "script-0/1", state: "failed-not-applied" },
          { id: "script-0/2", state: "completed" },
        ],
      },
    ]);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
      "alpha\nRACE_REMOVE_GAMMA\nomega\n",
    );
  });
});

test("a failed exact-text selector leaves other Codemode edits in the same file intact", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-exact-text-retry", [
      `await tools.replace({path:"note.txt",at:"gamma",text:"G"});
const result = await tools.replace({path:"note.txt",at:"a",text:"BAD"});
if (result !== null) throw Error("The ambiguous selector was accepted");
await tools.replace({path:"note.txt",at:"omega",text:"O"});`,
    ]);
    expect(getToolExecution(run, "script-0").isError).toBe(false);
    expect(
      batchDetails(run).editorBatches.flatMap((batch) => batch.calls.map((call) => call.state)),
    ).toEqual(["completed", "completed"]);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nbeta\nG\nO\n");
  });
});

test("a batch whose every anchor is gone says that no file was changed", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-external-content", [
      'text(await tools.replace({path:"note.txt",at:"alpha",text:"RACE"}));',
    ]);
    const output = getToolResultText(run, "script-0");
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    expect(output).toContain("alpha");
    expect(batchDetails(run).editorBatches).toEqual([
      {
        applied: false,
        calls: [{ id: "script-0/1", state: "failed-not-applied" }],
      },
    ]);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("external\n");
    expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(0);
  });
});

test("completed Write is not replayed after another writer changes the file", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await runScripts(cwd, "native-codemode-write-external-change", [
      'text(await tools.write({path:"created.txt",content:"planned"}));',
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    const recorded = await events(cwd);
    expect(
      recorded.find((event) => event.type === "result" && event.name === "write")?.content,
    ).toBe("planned");
    expect(await readFile(path.join(cwd, "created.txt"), "utf8")).toBe("");
    expect(recorded.filter((event) => event.type === "edit")).toHaveLength(1);
  });
});

test("a script deadline discards pending edits and the next script gets a fresh batch", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-deadline", [
      '// @options: {"timeout_ms":2000}\ntext(await tools.replace({path:"note.txt",at:"alpha",text:"PENDING"})); while (true) {}',
      'text(await tools.replace({path:"note.txt",at:"alpha",text:"CLEAN"}));',
    ]);
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    const interruption = getToolExecutionDetails(getToolExecution(run, "script-0"));
    expect(interruption).toHaveProperty("editorBatchResults.0.data.effect", "not-applied");
    expect(interruption).toHaveProperty("editorBatchResults.0.errors.0.code", "CANCELLED");
    expect(interruption).toHaveProperty("editorBatchResults.0.data.operations.0.files", [
      { source: expect.stringMatching(/\/note\.txt$/u) as unknown, effect: "not-applied" },
    ]);
    expect(getToolExecution(run, "script-1").isError, getToolResultText(run, "script-1")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("CLEAN\nbeta\ngamma\nomega\n");
    expect(
      (await events(cwd)).filter((event) => event.type === "edit").map((event) => event.before),
    ).toEqual([initial]);
  });
});

test("a deadline with clipped output still discards pending Insert edits", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-clipped-deadline", [
      '// @options: {"timeout_ms":2000,"max_output_tokens":10000}\nawait tools.insert({path:"note.txt",after:"alpha",text:"UNEXPECTED"}); text("x".repeat(100000)); while (true) {}',
    ]);
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(initial);
    expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(0);
  });
});
test("an ordinary error after deadline-like script output keeps accepted edits", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-deadline-like-output", [
      'await tools.insert({path:"note.txt",after:"alpha",text:"KEPT\\n"}); text("Script error:\\nScript timed out: script output only"); throw new Error("ordinary failure");',
    ]);
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
      "alpha\nKEPT\nbeta\ngamma\nomega\n",
    );
    expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(1);
  });
});
test.each([false, true])(
  "an ordinary exception containing a timeout marker keeps edits with clipped output=%s",
  async (clipped) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), initial);
      const run = await runScripts(cwd, `native-codemode-marker-in-error-${clipped}`, [
        (clipped ? '// @options: {"max_output_tokens":1000}\n' : "") +
          'await tools.insert({path:"note.txt",after:"alpha",text:"KEPT\\n"});' +
          (clipped ? 'text("x".repeat(100000));' : "") +
          'throw new Error("Script error:\\nScript timed out: copied failure");',
      ]);
      expect(getToolExecution(run, "script-0").isError).toBe(true);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
        "alpha\nKEPT\nbeta\ngamma\nomega\n",
      );
      expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(1);
    });
  },
);
test("five text operations share a multi-file snapshot batch before immediate Write", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    await writeFile(path.join(cwd, "target.txt"), "head\nmid\ntail\n");
    const run = await runScripts(cwd, "native-codemode-six-tools", [
      'text(await tools.insert({path:"note.txt",before:"alpha",text:"added\\n"}));\n' +
        'text(await tools.replace({path:"note.txt",at:"beta",text:"BETA"}));\n' +
        'text(await tools.delete({path:"note.txt",at:"gamma\\n"}));\n' +
        'text(await tools.copy({path:"note.txt",at:"alpha\\n",target:"target.txt",targetAfter:"head\\n"}));\n' +
        'text(await tools.move({path:"note.txt",at:"omega\\n",target:"target.txt",targetAfter:"tail\\n"}));\n' +
        'text(await tools.write({path:"new.txt",content:"created\\n"}));',
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(batchDetails(run).editorBatches).toHaveLength(1);
    expect(batchDetails(run).editorBatches[0]?.calls).toHaveLength(5);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("added\nalpha\nBETA\n");
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe(
      "head\nalpha\nmid\ntail\nomega\n",
    );
    expect(await readFile(path.join(cwd, "new.txt"), "utf8")).toBe("created\n");
    const recorded = await events(cwd);
    expect(recorded.filter((event) => event.type === "guard")).toHaveLength(2);
    expect(recorded.filter((event) => event.type === "edit")).toHaveLength(3);
  });
});

test("whole-file copy runs after the pending text batch commits", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-whole-file-boundary", [
      'text(await tools.replace({path:"note.txt",at:"alpha",text:"FIRST"}));\n' +
        'text(await tools.copy({path:"note.txt",target:"copied.txt"}));',
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(batchDetails(run).editorBatches).toHaveLength(1);
    expect(await readFile(path.join(cwd, "copied.txt"), "utf8")).toBe(
      "FIRST\nbeta\ngamma\nomega\n",
    );
  });
});

test("resource-owning search anchors keep their normal stale-snapshot protection", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-search-anchor-boundary", [
      'const found = await tools.search({path:"note.txt",query:"beta"});\n' +
        "const selection = found.matches[0];\n" +
        'if (!selection) throw new Error("missing search selection");\n' +
        'text(await tools.replace({path:"note.txt",at:"beta",text:"changed"}));\n' +
        'if ((await tools.replace({path:selection,text:"wrong"})) !== null) throw new Error("stale selection was edited");',
    ]);
    // The stale selection resolves to null and its reason ends the Codemode result.
    const output = getToolResultText(run, "script-0");
    expect(getToolExecution(run, "script-0").isError, output).toBe(false);
    expect(codemodeFailures(output)).toMatch(/stale|changed|expired/iu);
    expect(batchDetails(run).editorBatches).toHaveLength(1);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
      initial.replace("beta", "changed"),
    );
  });
});

test("a deadline cancels a boundary commit waiting on a slow guard", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-deadline-boundary", [
      '// @options: {"timeout_ms":2000}\nawait tools.replace({path:"note.txt",at:"alpha",text:"SLOW_BOUNDARY"}); await tools.read({path:"note.txt"});',
    ]);
    // The probe keeps the real workspace alive after the parent for late-effect checks.
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    expect(batchDetails(run).editorBatches).toEqual([
      { applied: false, calls: [{ id: "script-0/1", state: "failed-not-applied" }] },
    ]);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(initial);
    expect((await events(cwd)).filter((event) => event.type === "guard")).toHaveLength(1);
    expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(0);
  });
});

test.each([
  { name: "pending-deadline", committed: false, deadline: true, remains: false },
  { name: "committed-deadline", committed: true, deadline: true, remains: true },
  { name: "ordinary-error", committed: false, deadline: false, remains: true },
])("Copy preserves the interruption boundary: $name", async (scenario) => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "source.txt"), "alpha\n");
    await writeFile(path.join(cwd, "target.txt"), "head\ntail\n");
    const run = await runScripts(cwd, `copy-interruption-${scenario.name}`, [
      `${scenario.deadline ? '// @options: {"timeout_ms":2000}\n' : ""}
text(await tools.copy({path:"source.txt",at:"alpha\\n",target:"target.txt",targetAfter:"head\\n"}));
${scenario.committed ? 'await tools.read({path:"target.txt"});' : ""}
${scenario.deadline ? "while(true) {}" : 'throw Error("ordinary Copy script error");'}`,
    ]);
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("alpha\n");
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe(
      scenario.remains ? "head\nalpha\ntail\n" : "head\ntail\n",
    );
    expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(
      scenario.remains ? 1 : 0,
    );
    expect(getToolExecutionDetails(getToolExecution(run, "script-0"))).toHaveProperty(
      "editorBatchResults.0.data.effect",
      scenario.remains ? "applied" : "not-applied",
    );
    if (!scenario.remains)
      expect(getToolExecutionDetails(getToolExecution(run, "script-0"))).toHaveProperty(
        "editorBatchResults.0.errors.0.code",
        "CANCELLED",
      );
    expect(getToolResultText(run, "script-0")).toContain(
      scenario.remains ? "Editor batches: 1 committed" : "No file was changed.",
    );
  });
});
test("agent abort discards accepted but unwritten edits", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(
      cwd,
      "native-codemode-abort",
      [
        'text(await tools.replace({path:"note.txt",at:"alpha",text:"ABORT_PENDING"})); while (true) {}',
      ],
      "on",
      [],
      false,
    );
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    const interruption = getToolExecutionDetails(getToolExecution(run, "script-0"));
    expect(interruption).toHaveProperty("editorBatchResults.0.data.effect", "not-applied");
    expect(interruption).toHaveProperty("editorBatchResults.0.errors.0.code", "CANCELLED");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(initial);
    expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(0);
  });
});

test("a Rust Codemode batch preserves each file's original formatting", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "Cargo.toml"),
      '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    await writeFile(path.join(cwd, "loose.rs"), "fn main(){let a=1;let b=2;}\n");
    await writeFile(path.join(cwd, "styled.rs"), "fn main() {\n    let a = 1;\n}\n");
    const run = await runScripts(cwd, "native-codemode-rust-style", [
      'text(await tools.replace({path:"loose.rs",at:"a=1",text:"a=3"})); text(await tools.replace({path:"loose.rs",at:"b=2",text:"b=4"})); text(await tools.replace({path:"styled.rs",at:"let a = 1;",text:"let a=3;"}));',
    ]);
    expect(getToolExecution(run, "script-0").isError).toBe(false);
    expect(await readFile(path.join(cwd, "loose.rs"), "utf8")).toBe(
      "fn main(){let a=3;let b=4;}\n",
    );
    expect(await readFile(path.join(cwd, "styled.rs"), "utf8")).toBe(
      "fn main() {\n    let a = 3;\n}\n",
    );
  });
}, 60_000);
test("a multi-file batch formats each final file once", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "a.note"), "alpha\nbeta\n");
    await writeFile(path.join(cwd, "b.note"), "gamma\n");
    const run = await runScripts(
      cwd,
      "native-codemode-format-once",
      [
        'text(await tools.replace({path:"a.note",at:"alpha",text:"first"})); text(await tools.replace({path:"a.note",at:"beta",text:"second"})); text(await tools.replace({path:"b.note",at:"gamma",text:"third"}));',
      ],
      "on",
      [path.resolve("tests/integration/support/final-post-edit-extension.ts")],
    );
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "a.note"), "utf8")).toBe("FIRST\nSECOND\n");
    expect(await readFile(path.join(cwd, "b.note"), "utf8")).toBe("THIRD\n");
    const formats = (await readFile(path.join(cwd, "format-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { content: string });
    // Independent files may finish in either order; each final content must appear once.
    expect(formats.map((event) => event.content).sort()).toEqual(["first\nsecond\n", "third\n"]);
    expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(2);
    expect((await events(cwd)).filter((event) => event.type === "guard")).toHaveLength(1);
  });
});
