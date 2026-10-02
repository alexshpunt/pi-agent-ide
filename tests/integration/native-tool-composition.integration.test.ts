import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionResult,
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
    extensions: [
      path.resolve("src/pi-agent-ide.ts"),
      "builtin:codemode",
      path.resolve("tests/integration/support/mutation-result-probe.ts"),
      ...extraExtensions,
    ],
    tools: ["read", "search", "replace", "insert", "write", "codemode"],
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

test("composes a pending replace result through scoped Search and another edit", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "changed.txt"),
      "fresh outside\r\n😀 old block\r\nfresh outside",
    );
    const run = await runComposition(cwd, "replace-result-search-replace", [
      `const changed = await tools.replace({path:"changed.txt",start:"old block",text:"fresh chunk"});
if (changed.status !== "success" || changed.data.effect !== "pending") throw Error("Expected a pending native edit");
const found = await tools.search({path:changed,query:"fresh"});
if (found.status !== "success") throw Error(JSON.stringify(found.errors));
if (found.data.matches.length !== 1 || found.data.matches[0].range.startColumn !== 3) throw Error("Search escaped the new text or lost its source position");
const next = await tools.replace({path:found,text:"FINAL"});
if (next.status !== "success") throw Error(JSON.stringify(next.errors));
text({first:changed.data.effect,matches:found.data.matches,second:next.data.effect});`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "changed.txt"), "utf8")).toBe(
      "fresh outside\r\n😀 FINAL chunk\r\nfresh outside",
    );
  });
});

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

test("composes inserted text without searching identical neighbors", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "inserted.txt"), "same before\r\nanchor\r\nsame after");
    const run = await runComposition(cwd, "insert-result-search-replace", [
      `const changed = await tools.insert({path:"inserted.txt",anchor:"anchor",text:"same new"});
if (changed.status !== "success" || changed.data.effect !== "pending") throw Error("Expected pending insert");
const found = await tools.search({path:changed,query:"same"});
if (found.status !== "success" || found.data.matches.length !== 1 || found.data.matches[0].range.startLine !== 3) throw Error("Lost inserted scope");
text(await tools.replace({path:found,text:"ONLY"}));`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "inserted.txt"), "utf8")).toBe(
      "same before\r\nanchor\r\nONLY new\r\nsame after",
    );
  });
});

test("maps a pending result past earlier batch peers and retains it across calls", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "peers.txt"), "x A\r\n😀 B");
    const run = await runComposition(cwd, "mutation-result-batch-peer-shifts", [
      `await tools.replace({path:"peers.txt",start:"A",text:"FRESH\\r\\nSHIFT"});
const changed = await tools.replace({path:"peers.txt",start:"B",text:"FRESH"});
store("changed",changed);
const found = await tools.search({path:changed,query:"FRESH"});
if (found.status !== "success" || found.data.matches.length !== 1 || found.data.matches[0].range.startLine !== 3 || found.data.matches[0].range.startColumn !== 3) throw Error("Batch peer shifted target incorrectly");
text(found);`,
      `const found = await tools.search({path:load("changed"),query:"FRESH"});
if (found.status !== "success" || found.data.matches.length !== 1) throw Error("Committed result could not be reused");
text(await tools.replace({path:found,text:"ONLY"}));`,
    ]);
    for (const id of ["compose-0", "compose-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(await readFile(path.join(cwd, "peers.txt"), "utf8")).toBe("x FRESH\r\nSHIFT\r\n😀 ONLY");
  });
});

test("runs post-edit handlers once after all dependent calls and then expires old targets", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "format.txt"), "old body\n");
    const run = await runComposition(
      cwd,
      "mutation-result-final-post-edit",
      [
        `const first = await tools.replace({path:"format.txt",start:"old body",text:"format_me"});
const found = await tools.search({path:first,query:"format_me"});
if (found.status !== "success" || found.data.matches.length !== 1) throw Error("Post-edit handler ran before dependent Search");
const second = await tools.replace({path:found,text:"final format_me"});
store("beforeFormatting",second);
const final = await tools.search({path:second,query:"format_me"});
if (final.status !== "success" || final.data.matches.length !== 1) throw Error("Post-edit handler ran before script finished");
text(final);`,
        `const stale = await tools.search({path:load("beforeFormatting"),query:"FORMATTED"});
if (stale.status !== "error" || !stale.errors.some(e=>e.message.includes("stale"))) throw Error("Formatter silently rebound old target");
text(stale);`,
      ],
      [path.resolve("tests/integration/support/native-post-edit-probe.ts")],
    );
    for (const id of ["compose-0", "compose-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(await readFile(path.join(cwd, "format.txt"), "utf8")).toBe("final FORMATTED\n");
    const events = (await readFile(path.join(cwd, "post-edit-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { content: string });
    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe("final format_me\n");
    expect(getToolResultText(run, "compose-0")).toContain("Fixture formatting finished");
    expect(getToolResultText(run, "compose-0")).toContain("FORMATTED");
  });
});

test("consumes a pending result directly in a dependent replace", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "direct.txt"), "new outside\nx old block\nnew outside\n");
    const run = await runComposition(cwd, "pending-result-direct-replace", [
      `const first = await tools.replace({path:"direct.txt",start:"old block",text:"new block"});
const second = await tools.replace({path:first,text:"FINAL"});
if (second.status !== "success") throw Error(JSON.stringify(second.errors));
text(second);`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "direct.txt"), "utf8")).toBe(
      "new outside\nx FINAL\nnew outside\n",
    );
  });
});

test("keeps an empty replacement as a resulting position rather than deleted text", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "empty-replacement.txt"), "😀 old\r\nkeep");
    const run = await runComposition(cwd, "empty-replacement-result-position", [
      `const changed = await tools.replace({path:"empty-replacement.txt",start:"old",text:""});
const removed = await tools.search({path:changed,query:"old"});
if (removed.status !== "success" || removed.data.matches.length !== 0) throw Error("Deleted bytes became live text");
const separator = await tools.search({path:changed,query:"regex:[[:space:]]"});
if (separator.status !== "success" || separator.data.matches.length !== 0) throw Error("Empty target gained an invented delimiter");
const position = await tools.search({path:changed,query:"regex:^"});
if (position.status !== "success" || position.data.matches.length !== 1 || position.data.matches[0].range.startColumn !== 3) throw Error("Lost empty resulting position");
text(await tools.replace({path:position,text:"NEW"}));`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "empty-replacement.txt"), "utf8")).toBe("😀 NEW\r\nkeep");
  });
});

test.each([false, true])(
  "standalone replace publishes a target only when mapping survives formatting=%s",
  async (format) => {
    await withTempWorkspace(async (cwd) => {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
      );
      await writeFile(path.join(cwd, "format.txt"), "old body\n");
      const run = await new PiIntegrationTest({
        testName: `standalone-mutation-result-${format}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        rawMode: false,
        cwd,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          ...(format ? [path.resolve("tests/integration/support/native-post-edit-probe.ts")] : []),
        ],
        tools: ["replace"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "standalone",
                name: "replace",
                arguments: { path: "format.txt", start: "old", text: "format_me" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Standalone finished.")]),
        ],
      }).run("Publish a truthful standalone mutation receipt");
      expect(getToolExecution(run, "standalone").isError).toBe(false);
      const result = getToolExecutionResult(run, "standalone") as {
        structuredContent: {
          status: string;
          data: { effect: string; target?: string; targetUnavailable?: string };
        };
      };
      expect(result.structuredContent).toMatchObject({
        status: "success",
        data: { effect: "applied" },
      });
      if (format) {
        expect(result.structuredContent.data.target).toBeUndefined();
        expect(result.structuredContent.data.targetUnavailable).toContain(
          "actual written snapshot",
        );
      } else expect(result.structuredContent.data.target).toMatch(/^RESULT#/u);
      expect(await readFile(path.join(cwd, "format.txt"), "utf8")).toBe(
        format ? "FORMATTED body\n" : "format_me body\n",
      );
    });
  },
);
test("retains separate sparse and multi-file ranges in a mutation result", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "a.txt"), "old one\nNEW gap\nold two\n");
    await writeFile(path.join(cwd, "b.txt"), "old three\nNEW outside\n");
    const run = await runComposition(cwd, "mutation-result-sparse-files", [
      `const a = await tools.search({path:"a.txt",query:"old"});
const b = await tools.read({path:"b.txt",limit:1});
const found = await tools.search({path:[a,b],query:"old"});
const changed = await tools.replace({path:found,text:"NEW"});
const refined = await tools.search({path:changed,query:"NEW"});
if (refined.status !== "success" || refined.data.matches.length !== 3) throw Error("Mutation result widened its sparse scope");
text(await tools.replace({path:refined,text:"FINAL"}));`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("FINAL one\nNEW gap\nFINAL two\n");
    expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("FINAL three\nNEW outside\n");
  });
});

test("presents final formatting when a script has only resource-owned mutations", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "format.txt"), "old body\n");
    const run = await runComposition(
      cwd,
      "immediate-mutation-final-formatting",
      [
        `const found = await tools.search({path:"format.txt",query:"old"});
const changed = await tools.replace({path:found,text:"format_me"});
const intermediate = await tools.search({path:changed,query:"format_me"});
if (intermediate.status !== "success" || intermediate.data.matches.length !== 1) throw Error("Immediate mutation formatted before script completion");
text(changed);`,
      ],
      [path.resolve("tests/integration/support/native-post-edit-probe.ts")],
    );
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "format.txt"), "utf8")).toBe("FORMATTED body\n");
    expect(getToolResultText(run, "compose-0")).toContain("Fixture formatting finished");
    expect(run.tuiRenderedOutput).toContain("Formatted (fixture)");
    expect(run.tuiRenderedOutput).toMatch(/│\s+1 ~ FORMATTED body/u);
    expect(getToolResultText(run, "compose-0")).toContain("FORMATTED");
  });
});

test("finalizes surviving edits after an ordinary script error", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "format.txt"), "old body\n");
    const run = await runComposition(
      cwd,
      "mutation-result-script-error-finalization",
      [
        `const changed = await tools.replace({path:"format.txt",start:"old",text:"format_me"});
text(changed.data.target); throw Error("planned failure");`,
        `const saved = await tools.fixture_result({});
const stale = await tools.replace({path:saved.target,text:"WRONG"});
if (stale.status !== "error" || stale.data.effect !== "not-applied" || !stale.errors.some(e=>e.message.includes("stale"))) throw Error("Error finalization rebound a target"); text(stale);`,
      ],
      [path.resolve("tests/integration/support/native-post-edit-probe.ts")],
    );
    expect(getToolExecution(run, "compose-0").isError).toBe(true);
    expect(getToolExecution(run, "compose-1").isError, getToolResultText(run, "compose-1")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "format.txt"), "utf8")).toBe("FORMATTED body\n");
    expect(
      (await readFile(path.join(cwd, "post-edit-events.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  });
});

test("rejects a pending result after its script deadline without creating write authority", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "deadline.txt"), "old body\n");
    const run = await runComposition(cwd, "mutation-result-deadline", [
      `// @options: {"timeout_ms":2000}
const changed = await tools.replace({path:"deadline.txt",start:"old",text:"NEW"});
text(changed.data.target); while (true) {}`,
      `const saved = await tools.fixture_result({});
const rejected = await tools.replace({path:saved.target,text:"WRONG"});
if (rejected.status !== "error" || rejected.data.effect !== "not-applied") throw Error("Cancelled result gained authority"); text(rejected);`,
    ]);
    expect(getToolExecution(run, "compose-0").isError).toBe(true);
    expect(getToolExecution(run, "compose-1").isError, getToolResultText(run, "compose-1")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "deadline.txt"), "utf8")).toBe("old body\n");
  });
});
test.each(["GUARDED", "RACE"])(
  "never grants target authority to an uncommitted mutation: %s",
  async (replacement) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "pending-guard.txt"), "old\n");
      const run = await runComposition(
        cwd,
        `pending-result-${replacement}`,
        [
          `const changed = await tools.replace({path:"pending-guard.txt",start:"old",text:${JSON.stringify(replacement)}});
text(changed.data.target);
let blocked = false;
try { await tools.search({path:changed,query:${JSON.stringify(replacement)}}); } catch { blocked = true; }
if (!blocked) throw Error("Dependent Search was not blocked after write failure");`,
          `const saved = await tools.fixture_result({});
const rejected = await tools.replace({path:saved.target,text:"WRONG"});
if (rejected.status !== "error" || rejected.data.effect !== "not-applied") throw Error("Uncommitted handle gained authority");
text(rejected);`,
        ],
        [path.resolve("tests/integration/support/native-text-edit-probe.ts")],
      );
      expect(getToolExecution(run, "compose-0").isError).toBe(true);
      expect(getToolExecution(run, "compose-1").isError, getToolResultText(run, "compose-1")).toBe(
        false,
      );
      expect(await readFile(path.join(cwd, "pending-guard.txt"), "utf8")).toBe(
        replacement === "RACE" ? "external\n" : "old\n",
      );
    });
  },
);
