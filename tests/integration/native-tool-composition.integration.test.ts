import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolExecutionResult,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { withTextResultChecks } from "#integration/support/text-result-checks.js";

async function runComposition(
  cwd: string,
  name: string,
  scripts: readonly string[],
  extraExtensions: readonly string[] = [],
  prelude: readonly ReturnType<typeof assistantMessage>[] = [],
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
    rawMode: ![
      "copy-structured-scope-header",
      "move-structured-scope-header",
      "immediate-mutation-final-formatting",
    ].includes(name),
    cwd,
    extensions: [
      path.resolve("src/pi-agent-ide.ts"),
      "builtin:codemode",
      path.resolve("tests/integration/support/mutation-result-probe.ts"),
      ...extraExtensions,
    ],
    tools: [
      "read",
      "search",
      "select",
      "replace",
      "insert",
      "write",
      "copy",
      "move",
      "delete",
      "undo",
      "codemode",
    ],
    conversation: [
      ...prelude,
      ...scripts.map((code, index) =>
        assistantMessage(
          [
            toolCall({
              id: `compose-${index}`,
              name: "codemode",
              arguments: { code: withTextResultChecks(code) },
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("Composition finished.")]),
    ],
  }).run("Compose ordinary tools through source-aware results without rebuilding coordinates");
}

test("merged resource scheduling retains separate pending mutation targets", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "first.txt"), "😀 old\r\nprotected first");
    await writeFile(path.join(cwd, "second.txt"), "old\r\nprotected second");
    const run = await runComposition(cwd, "merged-concurrent-result-targets", [
      `const changes = await Promise.all([tools.replace({path:"first.txt",start:"old",text:"fresh"}), tools.replace({path:"second.txt",start:"old",text:"fresh"})]);
for (const changed of changes) if (typeof changed !== "string" || !changed.includes("not yet applied") || !changed) throw Error(JSON.stringify(changed));
const first = await tools.search({path:changes[0],query:"fresh"});
const second = await tools.search({path:changes[1],query:"fresh"});
if (typeof first !== "string" || typeof second !== "string" || matches(first).length !== 1 || matches(second).length !== 1 || matchRows(first)[0].source === matchRows(second)[0].source) throw Error("Concurrent targets crossed sources");
text(await tools.replace({path:first,text:"FIRST"}));
text(await tools.replace({path:second,text:"SECOND"}));`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "first.txt"), "utf8")).toBe("😀 FIRST\r\nprotected first");
    expect(await readFile(path.join(cwd, "second.txt"), "utf8")).toBe("SECOND\r\nprotected second");
  });
});

test("merged fuzzy candidates compose without widening an exact zero or clipping their stored scope", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "hints.txt"), "hintStrings\r\n".repeat(4) + "hintStrings");
    await writeFile(path.join(cwd, "outside.txt"), "hintStrings\r\nprotected");
    const run = await runComposition(cwd, "merged-fuzzy-source-targets", [
      `const read=await tools.read({path:"hints.txt",offset:1,limit:1});
const scopedZero=await tools.search({path:read,query:"hintStringz"});
check(scopedZero.includes("No matches") && !scopedZero.includes("Possible name:"),"Scoped zero widened into fuzzy discovery");
const zero=await tools.search({path:"hints.txt",query:"hintStringz"});
check(zero.includes("No matches found") && zero.includes("Possible name: hintStrings") && zero.includes("5 matches"),"Candidate group missing");
await tools.replace({path:zero,text:"BAD"});
const reference=/Read: (SEARCH#[A-F0-9]+:all:line)/.exec(zero)?.[1];
check(reference,"Missing complete candidate reference");
const candidate=await tools.search({path:await tools.read({path:reference}),query:"hintStrings"});
const selected=await tools.select({path:candidate,operation:{kind:"sliceText",from:0,to:11}});
check(items(selected).length===5,"Candidate preview clipped scope");
text(await tools.replace({path:selected,text:"UPDATED"}));
await rejects(()=>tools.replace({path:candidate,text:"BAD"}),/expired|stale/);`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "hints.txt"), "utf8")).toBe(
      "UPDATED\r\n".repeat(4) + "UPDATED",
    );
    expect(await readFile(path.join(cwd, "outside.txt"), "utf8")).toBe("hintStrings\r\nprotected");
  });
});

test.each(["copy", "move"] as const)(
  "%s maps same-file destination after source shifts",
  async (operation) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "same.txt"), "😀 ONE\r\ngap\r\nDEST\r\nONE outside");
      const run = await runComposition(cwd, `same-file-${operation}-scope`, [
        `const source = await tools.search({path:"same.txt",query:"ONE"});
const destination = await tools.search({path:"same.txt",query:"DEST"});
const changed = await tools.${operation}({path:matches(source)[0],target:destination});
if (typeof changed !== "string") throw Error(JSON.stringify(changed));
const found = await tools.search({path:changed,query:"ONE"});
if (typeof found !== "string" || matches(found).length !== 1 || matchRows(found)[0].line !== 3) throw Error("Transfer output includes the source or lost its shifted destination");
text(await tools.replace({path:found,text:"NEW"}));`,
      ]);
      expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
        false,
      );
      expect(await readFile(path.join(cwd, "same.txt"), "utf8")).toBe(
        operation === "copy"
          ? "😀 ONE\r\ngap\r\nNEW\r\nONE outside"
          : "😀 \r\ngap\r\nNEW\r\nONE outside",
      );
    });
  },
);

test("CHANGE undo exposes the whole restored file while keeping the Git route", async () => {
  await withTempWorkspace(async (cwd) => {
    const git = (...args: string[]) => promisify(execFile)("git", args, { cwd });
    await git("init", "-q");
    const baseline = "fresh before\r\nold body\r\nfresh after";
    await writeFile(path.join(cwd, "restore.txt"), baseline);
    await git("add", "restore.txt");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "baseline",
    );
    await writeFile(path.join(cwd, "restore.txt"), baseline.replace("old", "new"));
    const run = await runComposition(cwd, "change-undo-whole-restored-result", [
      `const current = await tools.read({path:"restore.txt",views:["changes"]});
const change = current.match(/CHANGE#[A-F0-9]+/)?.[0];
if (!change) throw Error("Missing Git change reference");
const restored = await tools.undo({file:current,change});
if (typeof restored !== "string" || !restored) throw Error(JSON.stringify(restored));
const found = await tools.search({path:restored,query:"fresh"});
if (typeof found !== "string" || matches(found).length !== 2) throw Error("Git undo exposed only its reversed span");
text(await tools.replace({path:matches(found)[0],text:"NEW"}));`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "restore.txt"), "utf8")).toBe(
      "NEW before\r\nold body\r\nfresh after",
    );
    expect((await git("show", ":restore.txt")).stdout).toBe(baseline);
  });
});

test.each(["write", "copy", "move"] as const)(
  "%s output expires after final formatting, not during composition",
  async (operation) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "format.txt"), "old body\r\n");
      await writeFile(path.join(cwd, "source.txt"), "format_me outside\r\nformat_me");
      const script =
        operation === "write"
          ? 'const changed = await tools.write({path:"format.txt",content:"format_me\\r\\n"});'
          : `const source = await tools.search({path:"source.txt",query:"format_me"});
const destination = await tools.search({path:"format.txt",query:"old body"});
const changed = await tools.${operation}({path:matches(source).slice(1),target:destination});`;
      const run = await runComposition(
        cwd,
        `${operation}-final-formatting-result-expiry`,
        [
          script +
            `
if (typeof changed !== "string" || !changed) throw Error(JSON.stringify(changed));
const found = await tools.search({path:changed,query:"format_me"});
if (typeof found !== "string" || matches(found).length !== 1) throw Error("Formatting ran early or scope included a source");
store("before-format",changed); text({operation:"${operation}",matches:matches(found).length});`,
          `const refused = await rejects(()=>tools.replace({path:load("before-format"),text:"BAD"}));
check(typeof refused==="string","Pre-format scope rebound after the script"); text({effect:refused});`,
        ],
        [path.resolve("tests/integration/support/native-post-edit-probe.ts")],
      );
      for (const index of [0, 1])
        expect(
          getToolExecution(run, `compose-${index}`).isError,
          getToolResultText(run, `compose-${index}`),
        ).toBe(false);
      expect(await readFile(path.join(cwd, "format.txt"), "utf8")).toBe("FORMATTED\r\n");
      const events = (await readFile(path.join(cwd, "post-edit-events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line: string) => JSON.parse(line) as { content: string });
      expect(events).toHaveLength(1);
      expect(events[0]?.content).toBe("format_me\r\n");
    });
  },
);

test("composes a pending replace result through scoped Search and another edit", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "changed.txt"),
      "fresh outside\r\n😀 old block\r\nfresh outside",
    );
    const run = await runComposition(cwd, "replace-result-search-replace", [
      `const changed = await tools.replace({path:"changed.txt",start:"old block",text:"fresh chunk"});
if (typeof changed !== "string" || !changed.includes("not yet applied")) throw Error("Expected a pending native edit");
const found = await tools.search({path:changed,query:"fresh"});
if (typeof found !== "string") throw Error(JSON.stringify(found));
if (matches(found).length !== 1 || matchRows(found)[0].column !== 3) throw Error("Search escaped the new text or lost its source position");
const next = await tools.replace({path:found,text:"FINAL"});
if (typeof next !== "string") throw Error(JSON.stringify(next));
text(changed); text(found); text(next);`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "changed.txt"), "utf8")).toBe(
      "fresh outside\r\n😀 FINAL chunk\r\nfresh outside",
    );
  });
});

test("composes the whole written file through a pending write result", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await runComposition(cwd, "write-result-search-replace", [
      `const written = await tools.write({path:"written.txt",content:"😀 fresh first\\r\\nfresh second"});
if (typeof written !== "string" || !written.includes("not yet applied") || !written) throw Error("Write did not reserve a whole-file target");
const found = await tools.search({path:written,query:"fresh"});
if (typeof found !== "string" || matches(found).length !== 2 || matchRows(found)[0].column !== 3) throw Error("Write result lost its source mapping");
const changed = await tools.replace({path:matches(found)[0],text:"NEW"});
if (typeof changed !== "string") throw Error(JSON.stringify(changed)); text(changed);`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "written.txt"), "utf8")).toBe(
      "😀 NEW first\r\nfresh second",
    );
  });
});

test("accepts only whole-file structured write inputs without widening windows", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "whole.txt"), "keep\r\nold\r\nneighbor");
    const run = await runComposition(cwd, "write-structured-input-boundaries", [
      `const window = await tools.read({path:"whole.txt",offset:2,limit:1});
const refused = await rejects(()=>tools.write({path:window,content:"WRONG"}));
check(typeof refused==="string","Write widened a partial source scope");
const current = await tools.read({path:"whole.txt"});
if (body(current)!==["keep","old","neighbor"].join(String.fromCharCode(13,10))) throw Error("Refused write changed source bytes");
const written = await tools.write({path:current,content:"fresh whole\\r\\n"});
if (typeof written !== "string" || !written) throw Error("Whole-file input did not compose");
const found = await tools.search({path:written,query:"fresh"});
if (typeof found !== "string" || matches(found).length !== 1) throw Error("Whole-file write target unavailable");
text(await tools.replace({path:found,text:"NEW"}));`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "whole.txt"), "utf8")).toBe("NEW whole\r\n");
  });
});

test.each(["copy", "move"] as const)(
  "pairs structured %s selections in declared order and targets only destinations",
  async (operation) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "source.txt"), "😀 ONE\r\nTWO\r\nONE outside");
      await writeFile(path.join(cwd, "destination.txt"), "LEFT\r\nRIGHT\r\nONE outside");
      const run = await runComposition(cwd, `${operation}-structured-pair-order`, [
        `const window = await tools.read({path:"source.txt",limit:2});
const source = await tools.search({path:window,query:"regex:ONE|TWO"});
const destination = await tools.search({path:"destination.txt",query:"regex:LEFT|RIGHT"});
const changed = await tools.${operation}({path:matches(source).slice().reverse(),target:destination});
if (typeof changed !== "string" || !changed) throw Error(JSON.stringify(changed));
const found = await tools.search({path:changed,query:"regex:ONE|TWO"});
if (typeof found !== "string" || matches(found).length !== 2 || matchRows(found).some(m=>!m.source.endsWith("destination.txt"))) throw Error("Transfer result escaped the destination ranges");
const first = matchRows(found).filter(m=>m.line===1).map(m=>m.ref);
text(await tools.replace({path:first,text:"NEW"}));`,
      ]);
      expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
        false,
      );
      expect(await readFile(path.join(cwd, "destination.txt"), "utf8")).toBe(
        "NEW\r\nONE\r\nONE outside",
      );
      expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe(
        operation === "copy" ? "😀 ONE\r\nTWO\r\nONE outside" : "😀 \r\n\r\nONE outside",
      );
    });
  },
);

test.each(["copy", "move"] as const)(
  "inserts structured %s into an exact zero-width destination",
  async (operation) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "source.txt"), "😀 ONE\r\nONE outside");
      await writeFile(path.join(cwd, "destination.txt"), "LEFT gap RIGHT\r\nONE outside");
      const run = await runComposition(cwd, `${operation}-zero-width-destination`, [
        `const sourceWindow = await tools.read({path:"source.txt",limit:1});
const source = await tools.search({path:sourceWindow,query:"ONE"});
const point = await tools.replace({path:"destination.txt",start:"gap",text:""});
const changed = await tools.${operation}({path:[matches(source)[0],matches(source)[0]],target:point});
if (typeof changed !== "string" || !changed) throw Error(JSON.stringify(changed));
const found = await tools.search({path:changed,query:"ONE"});
if (typeof found !== "string" || matches(found).length !== 1 || matchRows(found)[0].column !== 5) throw Error("Zero-width target widened or lost coordinates");
text(await tools.replace({path:found,text:"NEW"}));`,
      ]);
      expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
        false,
      );
      expect(await readFile(path.join(cwd, "destination.txt"), "utf8")).toBe(
        "LEFT NEW RIGHT\r\nONE outside",
      );
      expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe(
        operation === "copy" ? "😀 ONE\r\nONE outside" : "😀 \r\nONE outside",
      );
    });
  },
);

test("rejects unequal, overlapping, stale and forged transfer selections without writes", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "source.txt"), "ONE TWO\r\nneighbor");
    await writeFile(path.join(cwd, "destination.txt"), "LEFT RIGHT\r\nneighbor");
    const run = await runComposition(cwd, "transfer-result-refusals", [
      `const source = await tools.search({path:"source.txt",query:"regex:ONE|TWO"});
const destination = await tools.search({path:"destination.txt",query:"regex:LEFT|RIGHT"});
await rejects(()=>tools.copy({path:source,target:matches(destination)[0]}));
await rejects(()=>tools.move({path:source,target:source}),/[Oo]verlap/);
await rejects(()=>tools.copy({path:"RESULT#forged",target:destination}));
const empty=await tools.copy({path:[],target:[]});
check(empty.includes("Empty result target set; no changes"),"Empty pairing changed sources");
await tools.replace({path:"source.txt",start:"ONE",text:"NEW"});
await rejects(()=>tools.move({path:source,target:destination}),/expired|stale/);
text({refusals:4,empty:true});`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("NEW TWO\r\nneighbor");
    expect(await readFile(path.join(cwd, "destination.txt"), "utf8")).toBe(
      "LEFT RIGHT\r\nneighbor",
    );
  });
});

test.each(["copy", "move"] as const)(
  "composes pending legacy %s and reports only actual source effects",
  async (operation) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "source.txt"), "😀 ONE\r\nneighbor");
      await writeFile(path.join(cwd, "destination.txt"), "anchor\r\nONE outside");
      const run = await runComposition(cwd, `${operation}-pending-legacy-result`, [
        `const changed = await tools.${operation}({path:"source.txt",start:"ONE",target:"destination.txt",targetStart:"anchor"});
if (typeof changed !== "string" || !changed.includes("not yet applied") || !changed) throw Error("Legacy transfer did not reserve an output");
const found = await tools.search({path:changed,query:"ONE"});
if (typeof found !== "string" || matches(found).length !== 1 || !matchRows(found)[0].source.endsWith("destination.txt")) throw Error("Pending output included removals or neighbors");
text(await tools.replace({path:found,text:"NEW"}));`,
      ]);
      expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
        false,
      );
      const details = getToolExecutionDetails(getToolExecution(run, "compose-0")) as {
        editorBatchResults: { data: { files: { source: string; effect: string }[] } }[];
      };
      expect(details.editorBatchResults).toHaveLength(1);
      const receipt = details.editorBatchResults[0];
      if (!receipt) throw new Error("Missing automatic commit receipt");
      expect(
        receipt.data.files.map(({ source, effect }) => ({
          source: path.basename(source),
          effect,
        })),
      ).toEqual([
        { source: "source.txt", effect: operation === "copy" ? "not-applied" : "applied" },
        { source: "destination.txt", effect: "applied" },
      ]);
      expect(await readFile(path.join(cwd, "destination.txt"), "utf8")).toBe(
        "anchor\r\nNEW\r\nONE outside",
      );
      expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe(
        operation === "copy" ? "😀 ONE\r\nneighbor" : "😀 \r\nneighbor",
      );
    });
  },
);

test.each(["copy", "move"] as const)(
  "shows both structured %s scopes without dumping input objects",
  async (operation) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "source.txt"), "ONE");
      await writeFile(path.join(cwd, "destination.txt"), "LEFT");
      const run = await runComposition(cwd, `${operation}-structured-scope-header`, [
        `const source = await tools.read({path:"source.txt"});
const destination = await tools.read({path:"destination.txt"});
const changed = await tools.${operation}({path:source,target:destination});
if (typeof changed !== "string") throw Error(JSON.stringify(changed));
text({effect:changed});`,
      ]);
      expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
        false,
      );
      expect(run.tuiRenderedOutput).toContain(
        operation === "copy" ? "copy result scope -> result scope" : "move 2 files",
      );
      expect(run.tuiRenderedOutput).not.toContain("[object Object]");
      expect(await readFile(path.join(cwd, "destination.txt"), "utf8")).toBe("ONE");
    });
  },
);

test("delete receipts describe removals without publishing a live point", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "removed.txt"), "keep\r\n😀 old\r\nold outside");
    const run = await runComposition(cwd, "delete-structured-removal-receipt", [
      `const window = await tools.read({path:"removed.txt",offset:2,limit:1});
const found = await tools.search({path:window,query:"old"});
const removed = await tools.delete({path:found});
await rejects(()=>tools.search({path:removed,query:"old"}),/no reusable text selection/);
const receipt = await tools.read({path:"removed.txt"});
if (!receipt.includes("😀 "+String.fromCharCode(13,10))) throw Error("Delete widened its selected range");
text(removed);`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "removed.txt"), "utf8")).toBe(
      "keep\r\n😀 \r\nold outside",
    );
    const shown = getToolResultText(run, "compose-0");
    expect(shown).toContain("removed.txt");
  });
});

test.each(["copy", "move"] as const)(
  "composes a whole-file %s destination and reports source state",
  async (operation) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "source.txt"), "😀 fresh\r\nneighbor");
      const run = await runComposition(cwd, `${operation}-whole-file-output`, [
        `const source = await tools.read({path:"source.txt"});
const changed = await tools.${operation}({path:source,target:"destination.txt"});
if (typeof changed !== "string" || !changed) throw Error(JSON.stringify(changed));
const found = await tools.search({path:changed,query:"fresh"});
if (typeof found !== "string" || matches(found).length !== 1 || !matchRows(found)[0].source.endsWith("destination.txt")) throw Error("No destination scope");
text(changed); text(await tools.replace({path:found,text:"NEW"}));`,
      ]);
      expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
        false,
      );
      expect(await readFile(path.join(cwd, "destination.txt"), "utf8")).toBe("😀 NEW\r\nneighbor");
      if (operation === "move")
        await expect(readFile(path.join(cwd, "source.txt"))).rejects.toThrow("ENOENT");
      else
        expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("😀 fresh\r\nneighbor");
    });
  },
);

test("undo accepts only a whole-file source and returns the whole restored file", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "restore.txt"), "fresh before\r\nold body\r\nfresh after");
    const run = await runComposition(cwd, "undo-whole-restored-output", [
      `const changed = await tools.replace({path:"restore.txt",start:"old body",text:"new body"});
const window = await tools.read({path:"restore.txt",offset:2,limit:1});
const refused = await rejects(()=>tools.undo({file:window,change:"last"}));
check(typeof refused==="string","Undo widened its input");
const whole = await tools.read({path:"restore.txt"});
const restored = await tools.undo({file:whole,change:"last"});
if (typeof restored !== "string" || !restored) throw Error(JSON.stringify(restored));
const found = await tools.search({path:restored,query:"fresh"});
if (typeof found !== "string" || matches(found).length !== 2) throw Error("Undo did not return the whole restored file");
text(restored); text(await tools.replace({path:matches(found)[0],text:"NEW"}));`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "restore.txt"), "utf8")).toBe(
      "NEW before\r\nold body\r\nfresh after",
    );
  });
});

test("whole-file operations preserve binary bytes without granting a text target", async () => {
  await withTempWorkspace(async (cwd) => {
    const bytes = Buffer.from([0, 255, 1, 13, 10, 128]);
    await writeFile(path.join(cwd, "source.bin"), bytes);
    await writeFile(path.join(cwd, "existing.bin"), bytes);
    const run = await runComposition(cwd, "file-operation-binary-and-refusal", [
      `const copied=await tools.copy({path:"source.bin",target:"copy.bin"});
await rejects(()=>tools.search({path:copied,query:"BAD"}),/no reusable text selection/);
const moved = await tools.move({path:"copy.bin",target:"existing.bin"});
await rejects(()=>tools.search({path:moved,query:"BAD"}),/no reusable text selection/);
text(copied);`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    for (const name of ["source.bin", "existing.bin"])
      expect(await readFile(path.join(cwd, name))).toEqual(bytes);
    await expect(readFile(path.join(cwd, "copy.bin"))).rejects.toThrow("ENOENT");
  });
});

test("whole-file structured delete removes text, while a string path removes the file", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "whole.txt"), "😀 old\r\nneighbor");
    const run = await runComposition(cwd, "delete-whole-text-versus-file", [
      `const source = await tools.read({path:"whole.txt"});
const textRemoval=await tools.delete({path:source});
const empty=await tools.read({path:"whole.txt"});
check(body(empty)==="","Text delete did not preserve an empty file");
await rejects(()=>tools.replace({path:textRemoval,text:"BAD"}),/no reusable text selection/);
text(await tools.delete({path:"whole.txt"}));`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    await expect(readFile(path.join(cwd, "whole.txt"))).rejects.toThrow("ENOENT");
  });
});

test("searches only a Read window and replaces a JS-selected match", async () => {
  await withTempWorkspace(async (cwd) => {
    const before = "old outside\r\n😀 old first\r\nold second\r\nold outside";
    await writeFile(path.join(cwd, "scope.txt"), before);
    const run = await runComposition(cwd, "read-search-replace-window", [
      `const read = await tools.read({path:"scope.txt",offset:2,limit:2});
if (typeof read !== "string") throw Error(JSON.stringify(read));
const found = await tools.search({path:read,query:"old"});
if (typeof found !== "string") throw Error(JSON.stringify(found));
if (matches(found).length !== 2) throw Error("Search escaped the read window");
text(found);
const changed = await tools.replace({path:matches(found)[0],text:"NEW"});
if (typeof changed !== "string") throw Error(JSON.stringify(changed));
text(changed);`,
    ]);
    const shown = getToolResultText(run, "compose-0");
    expect(getToolExecution(run, "compose-0").isError, shown).toBe(false);
    expect(await readFile(path.join(cwd, "scope.txt"), "utf8")).toBe(
      "old outside\r\n😀 NEW first\r\nold second\r\nold outside",
    );
    expect(shown).toContain(":2:4-");
    expect(shown).toContain("scope.txt");
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
if (typeof refined !== "string" || matches(refined).length !== 3) throw Error(JSON.stringify(refined));
const duplicate = [...matches(refined),matches(refined)[0]];
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
check(read.includes("Showing lines 1-2000 of 2101") && read.includes("offset=2001"),"Expected bounded Read preview");
const found=await tools.search({path:read,query:"old",limit:1});
check(found.includes("2101 matches") && found.includes("(compacted)") && matches(found).length===0,"Expected compacted Search presentation");
store("completeSelection",found); text(found);`,
      `const changed = await tools.replace({path:load("completeSelection"),text:"NEW"});
if (typeof changed !== "string") throw Error(JSON.stringify(changed)); text(changed);`,
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
const stale = await rejects(()=>tools.replace({path:found,text:"WRONG"}));
check(typeof stale==="string","Stale result was not safely rejected");
text(stale);
const current = await tools.read({path:"stale.txt"});
if (!current.includes("old updated old")) throw Error("Stale edit wrote source bytes");
text(await tools.replace({path:found.match(/SEARCH#[A-F0-9]+:all:match/)[0],text:"NEW"}));`,
    ]);
    for (const id of ["compose-0", "compose-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(await readFile(path.join(cwd, "stale.txt"), "utf8")).toBe("NEW updated NEW\n");
    expect(getToolResultText(run, "compose-1")).toMatch(/expired|stale/iu);
  });
});

test("keeps empty results distinct from unsupported or forged source data", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "empty.txt"), "safe\n");
    const run = await runComposition(cwd, "composition-empty-and-unsupported", [
      `const empty = await tools.search({path:"empty.txt",query:"absent"});
const nothing = await tools.replace({path:empty,text:"WRONG"});
if (typeof nothing !== "string") throw Error("Empty targets should be a successful no-op");
const emptyScope = await tools.search({path:[],query:"safe"});
if (typeof emptyScope !== "string" || matches(emptyScope).length !== 0) throw Error("Empty array widened to cwd");
for (const input of [{kind:"text",source:"empty.txt",lines:[{content:"safe"}]},{target:"RESULT#forged"},"RESULT#expired",{status:"partial",data:empty}]) {
const rejected = await rejects(()=>tools.replace({path:input,text:"WRONG"}));
check(typeof rejected==="string","Unsupported input gained write authority");
}
text(nothing);`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "empty.txt"), "utf8")).toBe("safe\n");
    expect(getToolResultText(run, "compose-0")).toContain("Empty result target set; no changes.");
  });
});

test("preserves zero-width source positions for replacement", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "position.txt"), "keep\n😀 body\n");
    const run = await runComposition(cwd, "composition-zero-width-target", [
      `const read = await tools.read({path:"position.txt",offset:2,limit:1});
const found = await tools.search({path:read,query:"regex:^"});
if (typeof found !== "string" || matches(found).length !== 1 || matchRows(found)[0].endColumn !== 0) throw Error("Lost zero-width target");
text(await tools.replace({path:found,text:"prefix "}));`,
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
const rejected = await rejects(()=>tools.replace({path:found,text:"GUARDED"}));
check(typeof rejected==="string","Structured targets bypassed the write guard");
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
if (typeof changed !== "string" || !changed.includes("not yet applied")) throw Error("Expected pending insert");
const found = await tools.search({path:changed,query:"same"});
if (typeof found !== "string" || matches(found).length !== 1 || matchRows(found)[0].line !== 3) throw Error("Lost inserted scope");
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
if (typeof found !== "string" || matches(found).length !== 1 || matchRows(found)[0].line !== 3 || matchRows(found)[0].column !== 3) throw Error("Batch peer shifted target incorrectly");
text(found);`,
      `const found = await tools.search({path:load("changed"),query:"FRESH"});
if (typeof found !== "string" || matches(found).length !== 1) throw Error("Committed result could not be reused");
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
if (typeof found !== "string" || matches(found).length !== 1) throw Error("Post-edit handler ran before dependent Search");
const second = await tools.replace({path:found,text:"final format_me"});
store("beforeFormatting",second);
const final = await tools.search({path:second,query:"format_me"});
if (typeof final !== "string" || matches(final).length !== 1) throw Error("Post-edit handler ran before script finished");
text(final);`,
        `const stale = await rejects(()=>tools.search({path:load("beforeFormatting"),query:"FORMATTED"}));
check(typeof stale==="string","Formatter silently rebound old target");
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
if (typeof second !== "string") throw Error(JSON.stringify(second));
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
if (typeof removed !== "string" || matches(removed).length !== 0) throw Error("Deleted bytes became live text");
const separator = await tools.search({path:changed,query:"regex:[[:space:]]"});
if (typeof separator !== "string" || matches(separator).length !== 0) throw Error("Empty target gained an invented delimiter");
const position = await tools.search({path:changed,query:"regex:^"});
if (typeof position !== "string" || matches(position).length !== 1 || matchRows(position)[0].column !== 3) throw Error("Lost empty resulting position");
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
          path.resolve("tests/integration/fixtures/forward-text-result.ts"),
          path.resolve("src/pi-agent-ide.ts"),
          ...(format ? [path.resolve("tests/integration/support/native-post-edit-probe.ts")] : []),
        ],
        tools: ["replace", "search"],
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
          assistantMessage(
            [
              toolCall({
                id: "reuse",
                name: "search",
                arguments: { path: "$previous-result", query: "format_me" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Standalone finished.")]),
        ],
      }).run("Publish a truthful standalone mutation receipt");
      expect(getToolExecution(run, "standalone").isError).toBe(false);
      expect(getToolExecutionResult(run, "standalone")).not.toHaveProperty("structuredContent");
      expect(getToolExecution(run, "reuse").isError, getToolResultText(run, "reuse")).toBe(format);
      if (!format) expect(getToolResultText(run, "reuse")).toContain("format_me");
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
if (typeof refined !== "string" || matches(refined).length !== 3) throw Error("Mutation result widened its sparse scope");
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
if (typeof intermediate !== "string" || matches(intermediate).length !== 1) throw Error("Immediate mutation formatted before script completion");
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
text(changed); throw Error("planned failure");`,
        `const saved = await tools.fixture_result({});
const stale = await rejects(()=>tools.replace({path:saved,text:"WRONG"}));
check(typeof stale==="string","Error finalization rebound a target"); text(stale);`,
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
text(changed); while (true) {}`,
      `const saved = await tools.fixture_result({});
const rejected = await rejects(()=>tools.replace({path:saved,text:"WRONG"}));
check(typeof rejected==="string","Cancelled result gained authority"); text(rejected);`,
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
text(changed);
let blocked = false;
try { await tools.search({path:changed,query:${JSON.stringify(replacement)}}); } catch { blocked = true; }
if (!blocked) throw Error("Dependent Search was not blocked after write failure");`,
          `const saved = await tools.fixture_result({});
const rejected = await rejects(()=>tools.replace({path:saved,text:"WRONG"}));
check(typeof rejected==="string","Uncommitted handle gained authority");
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
