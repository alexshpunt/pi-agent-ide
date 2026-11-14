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
await tools.insert({path:"note.txt",anchor:"alpha",before:true,text:"added"});
await tools.replace({path:${selected},start:"tail",text:"TAIL"});
await tools.delete({path:"note.txt",start:"gamma"});`,
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
await tools.insert({path:"note.txt",anchor:"alpha",before:true,text:"added"});
const rejected = await tools.replace({path:found,start:${JSON.stringify(scenario === "outside" ? "gamma" : "beta")},${scenario === "separate-ranges" ? 'end:"gamma",' : ""}text:"WRONG"});
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
              ? "start: found.matches[0]"
              : "start: found.matches[0].id";
      const run = await runScripts(cwd, "native-search-value-" + selection, [
        `const found = await tools.search({path:"note.txt",query:"beta"});
await tools.insert({path:"note.txt",anchor:"alpha",before:true,text:"added"});
await tools.replace({${argument},text:"BETA"});
await tools.delete({path:"note.txt",start:"gamma"});`,
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
await tools.replace({start:found.matches[0],text:"BETA"});
await tools.replace({path:"note.txt",start:"omega",text:"OMEGA"});`,
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
      `const changed = await tools.replace({path:"note.txt",start:"beta",text:"BETA"});
await tools.replace({path:"note.txt",start:changed,text:"FINAL"+String.fromCharCode(10)});
await tools.replace({path:"note.txt",start:"gamma",text:"GAMMA"});`,
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
await tools.replace({start:"SEARCH#"+session+":all:line",text:"RACE_EXPAND"});
await tools.replace({path:"a.txt",start:"alpha",text:"ALPHA"});`,
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
await tools.insert({path:"note.txt",anchor:"alpha",before:true,text:"added"});
await tools.replace({start:"SEARCH#"+session+":1:line",text:"BETA"});
await tools.delete({path:"note.txt",start:"gamma"});`,
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
await tools.insert({path:"note.txt",anchor:"alpha",before:true,text:"added"});
await tools.replace(${selection.endsWith("-path") ? '{path:selected,text:"BETA"}' : '{start:selected,text:"BETA"}'});
await tools.delete({path:"note.txt",start:"gamma"});`,
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
await tools.copy({start:"SEARCH#"+src+":1:line",targetStart:"SEARCH#"+dst+":1:line"});
await tools.move({start:"SEARCH#"+src+":2:line",targetStart:"SEARCH#"+dst+":2:line"});
await tools.insert({anchor:"SEARCH#"+src+":1:match",before:true,text:"prefix "});
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
await tools.replace({path:"note.txt",start:"SEARCH#"+session+":2:line",text:${JSON.stringify(race)}});
await tools.replace({start:"SEARCH#"+session+":1:line",text:"BETA"});
await tools.replace({path:"note.txt",start:"omega",text:"OMEGA"});
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
await tools.insert({path:"note.txt",anchor:"alpha",before:true,text:"added"});
await tools.replace({path:"SEARCH#"+session+":all:line",start:"gamma",text:"changed"});
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
await tools.replace({path:"a.txt",start:"alpha",text:"ALPHA"});
await tools.replace({start:"SEARCH#"+session+":all:line",text:"BETA"});
await tools.insert({path:"a.txt",anchor:"ALPHA",before:true,text:"added"});
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
await tools.replace({path:"note.txt",start:"alpha",text:"ALPHA"});
const rejected = await tools.replace({path:"other.txt",start:"SEARCH#"+session+":1:line",text:"wrong"});
if (rejected !== null) throw Error("mismatched source accepted");
await tools.replace({path:"note.txt",start:"omega",text:"OMEGA"});
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
        'text(await tools.replace({path:"note.note",start:"alpha",text:"first"}));\n' +
          'text(await tools.write({path:"note.note",content:"replacement\\n"}));\n' +
          'text(await tools.replace({path:"note.note",start:"REPLACEMENT",text:"changed"}));',
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
text(await tools.insert({path:"note.txt",anchor:${JSON.stringify(anchor(1, "alpha"))},before:true,text:"added"}));
text(await tools.replace({start:${JSON.stringify(anchor(2, "beta"))},text:"BETA"}));
text(await tools.delete({path:"note.txt",start:${JSON.stringify(anchor(3, "gamma"))}}));`,
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
await tools.replace({path:"note.txt",start:"alpha",text:"ALPHA"});
const shown = await tools.read({path:"note.txt"});
if (!shown.text.includes("ALPHA")) throw Error("Read did not see the committed edit");
const changed = await tools.replace({path:"note.txt",start:"beta",text:"BETA"});
await tools.replace({path:changed,text:"FINAL"+String.fromCharCode(10)});
text(await tools.replace({path:"note.txt",start:"gamma",text:"GAMMA"}));`,
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
      `text(await tools.insert({path:"note.txt",anchor:${JSON.stringify(anchor(1, "alpha"))},before:true,text:"added"}));
const shown = await tools.read({path:"note.txt",views:["anchors"]});
if (!shown.text.includes(${JSON.stringify(anchor(3, "beta"))})) throw new Error("read saw an uncommitted file");
text(await tools.replace({path:"note.txt",start:${JSON.stringify(anchor(3, "beta"))},text:"BETA"}));
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
    tail: `if ((await tools.replace({path:"note.txt",start:${JSON.stringify(anchor(2, "wrong"))},text:"wrong"})) === null) throw new Error("stale edit failed");`,
    message: "is stale",
  },
  {
    name: "blocked-hook",
    tail: 'await tools.replace({path:"note.txt",start:"beta",text:"BLOCKED"});',
    message: "fixture blocked this edit",
  },
  {
    name: "malformed-arguments",
    tail: 'await tools.replace({path:"note.txt",start:{invalid:true},text:"wrong"});',
    message: 'Validation failed for tool "replace"',
  },
])("accepted edits survive $name without bypassing validation", async (scenario) => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, `native-codemode-${scenario.name}`, [
      `text(await tools.insert({path:"note.txt",anchor:${JSON.stringify(anchor(1, "alpha"))},before:true,text:"added"}));\n${scenario.tail}`,
    ]);
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    expect(getToolResultText(run, "script-0")).toContain(scenario.message);
    expect(getToolResultText(run, "script-0")).toContain("Editor batches: 1 committed");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("added\n" + initial);
    expect((await events(cwd)).filter((event) => event.type === "edit")).toHaveLength(1);
  });
});

test("overlapping accepted-snapshot edits reject the second operation", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-overlap", [
      'text(await tools.replace({path:"note.txt",start:"alpha",text:"FIRST"})); text("second:" + (await tools.replace({path:"note.txt",start:"alpha",text:"SECOND"})));',
    ]);
    // The rejected second edit resolves to null; the first one is still committed.
    const output = getToolResultText(run, "script-0");
    expect(getToolExecution(run, "script-0").isError, output).toBe(false);
    expect(output).toContain("second:null");
    expect(codemodeFailures(output)).toContain("overlaps an earlier successful mutation");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("FIRST\nbeta\ngamma\nomega\n");
  });
});

test("a rejected combined write fails the parent and blocks the next read", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-write-guard", [
      'text(await tools.replace({path:"note.txt",start:"alpha",text:"GUARDED"})); text(await tools.read({path:"note.txt"}));',
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
      'text(await tools.replace({path:"note.txt",start:"alpha",text:"RACE_APPEND"}));' +
        'text(await tools.replace({path:"note.txt",start:"beta",text:"B"}));',
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
      'text(await tools.replace({path:"note.txt",start:"gamma",text:"G"}));' +
        'text(await tools.replace({path:"note.txt",start:"beta",text:"RACE_REMOVE_GAMMA"}));',
    ]);
    const output = getToolResultText(run, "script-0");
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    expect(output).toContain("Editor batch partly applied: 1 of 2 calls written.");
    expect(output).toContain('Call 1 (replace) was not applied: start "gamma"');
    expect(output).not.toContain("Call 2");
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

test("an accepted exact-text edit still commits after a later exact-text failure", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-exact-text-block", [
      'text(await tools.replace({path:"note.txt",start:"gamma",text:"G"}));' +
        'await tools.replace({path:"note.txt",start:"a",text:"ambiguous"});',
    ]);
    const output = getToolResultText(run, "script-0");
    expect(output).toContain("Editor batches: 1 committed");
    expect(output).not.toContain("Call 1");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nbeta\nG\nomega\n");
  });
});

test("a batch whose every anchor is gone says that no file was changed", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), initial);
    const run = await runScripts(cwd, "native-codemode-external-content", [
      'text(await tools.replace({path:"note.txt",start:"alpha",text:"RACE"}));',
    ]);
    const output = getToolResultText(run, "script-0");
    expect(getToolExecution(run, "script-0").isError).toBe(true);
    expect(output).toContain("Editor batch not applied: no file was changed.");
    expect(output).toContain('Call 1 (replace) was not applied: start "alpha"');
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
      '// @options: {"timeout_ms":2000}\ntext(await tools.replace({path:"note.txt",start:"alpha",text:"PENDING"})); while (true) {}',
      'text(await tools.replace({path:"note.txt",start:"alpha",text:"CLEAN"}));',
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
      '// @options: {"timeout_ms":2000,"max_output_tokens":10000}\nawait tools.insert({path:"note.txt",anchor:"alpha",text:"UNEXPECTED"}); text("x".repeat(100000)); while (true) {}',
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
      'await tools.insert({path:"note.txt",anchor:"alpha",text:"KEPT"}); text("Script error:\\nScript timed out: script output only"); throw new Error("ordinary failure");',
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
          'await tools.insert({path:"note.txt",anchor:"alpha",text:"KEPT"});' +
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
      'text(await tools.insert({path:"note.txt",anchor:"alpha",before:true,text:"added"}));\n' +
        'text(await tools.replace({path:"note.txt",start:"beta",text:"BETA"}));\n' +
        'text(await tools.delete({path:"note.txt",start:"gamma"}));\n' +
        'text(await tools.copy({path:"note.txt",start:"alpha",target:"target.txt",targetStart:"head"}));\n' +
        'text(await tools.move({path:"note.txt",start:"omega",target:"target.txt",targetStart:"tail"}));\n' +
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
      'text(await tools.replace({path:"note.txt",start:"alpha",text:"FIRST"}));\n' +
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
        'text(await tools.replace({path:"note.txt",start:"beta",text:"changed"}));\n' +
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
      '// @options: {"timeout_ms":2000}\nawait tools.replace({path:"note.txt",start:"alpha",text:"SLOW_BOUNDARY"}); await tools.read({path:"note.txt"});',
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
text(await tools.copy({path:"source.txt",start:"alpha",target:"target.txt",targetStart:"head"}));
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
        'text(await tools.replace({path:"note.txt",start:"alpha",text:"ABORT_PENDING"})); while (true) {}',
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
      'text(await tools.replace({path:"loose.rs",start:"a=1",text:"a=3"})); text(await tools.replace({path:"loose.rs",start:"b=2",text:"b=4"})); text(await tools.replace({path:"styled.rs",start:"let a = 1;",text:"let a=3;"}));',
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
        'text(await tools.replace({path:"a.note",start:"alpha",text:"first"})); text(await tools.replace({path:"a.note",start:"beta",text:"second"})); text(await tools.replace({path:"b.note",start:"gamma",text:"third"}));',
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
