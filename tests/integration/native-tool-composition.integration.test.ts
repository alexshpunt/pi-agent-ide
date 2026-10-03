import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
    rawMode: false,
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
      "replace",
      "insert",
      "write",
      "copy",
      "move",
      "delete",
      "undo",
      "apply",
      "codemode",
    ],
    conversation: [
      ...prelude,
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

test.each(["copy", "move"] as const)(
  "%s maps same-file destination after source shifts",
  async (operation) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "same.txt"), "😀 ONE\r\ngap\r\nDEST\r\nONE outside");
      const run = await runComposition(cwd, `same-file-${operation}-scope`, [
        `const source = await tools.search({path:"same.txt",query:"ONE"});
const destination = await tools.search({path:"same.txt",query:"DEST"});
const changed = await tools.${operation}({path:source.data.matches.slice(0,1),target:destination});
if (changed.status !== "success") throw Error(JSON.stringify(changed.errors));
const found = await tools.search({path:changed,query:"ONE"});
if (found.status !== "success" || found.data.matches.length !== 1 || found.data.matches[0].range.startLine !== 3) throw Error("Transfer output includes the source or lost its shifted destination");
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
const change = current.data.references?.find(reference => reference.kind === "change");
if (!change) throw Error("Missing Git change reference");
const restored = await tools.undo({file:current.data,change:change.value});
if (restored.status !== "success" || !restored.data.target) throw Error(JSON.stringify(restored));
const found = await tools.search({path:restored,query:"fresh"});
if (found.status !== "success" || found.data.matches.length !== 2) throw Error("Git undo exposed only its reversed span");
text(await tools.replace({path:found.data.matches.slice(0,1),text:"NEW"}));`,
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
const changed = await tools.${operation}({path:source.data.matches.slice(1),target:destination});`;
      const run = await runComposition(
        cwd,
        `${operation}-final-formatting-result-expiry`,
        [
          script +
            `
if (changed.status !== "success" || !changed.data.target) throw Error(JSON.stringify(changed));
const found = await tools.search({path:changed,query:"format_me"});
if (found.status !== "success" || found.data.matches.length !== 1) throw Error("Formatting ran early or scope included a source");
store("before-format",changed.data.target); text({operation:"${operation}",matches:found.data.matches.length});`,
          `const refused = await tools.replace({path:load("before-format"),text:"BAD"});
if (refused.status !== "error" || refused.data.effect !== "not-applied") throw Error("Pre-format scope rebound after the script"); text({effect:refused.data.effect});`,
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

test("composes the whole written file through a pending write result", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await runComposition(cwd, "write-result-search-replace", [
      `const written = await tools.write({path:"written.txt",content:"😀 fresh first\\r\\nfresh second"});
if (written.status !== "success" || written.data.effect !== "pending" || !written.data.target) throw Error("Write did not reserve a whole-file target");
const found = await tools.search({path:written,query:"fresh"});
if (found.status !== "success" || found.data.matches.length !== 2 || found.data.matches[0].range.startColumn !== 3) throw Error("Write result lost its source mapping");
const changed = await tools.replace({path:found.data.matches.slice(0,1),text:"NEW"});
if (changed.status !== "success") throw Error(JSON.stringify(changed.errors)); text(changed);`,
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
const refused = await tools.write({path:window,content:"WRONG"});
if (refused.status !== "error" || refused.data.effect !== "not-applied") throw Error("Write widened a partial source scope");
const current = await tools.read({path:"whole.txt"});
if (current.data.lines.length !== 3 || current.data.lines[0].content !== "keep") throw Error("Refused write changed source bytes");
const written = await tools.write({path:current.data,content:"fresh whole\\r\\n"});
if (written.status !== "success" || !written.data.target) throw Error("Whole-file input did not compose");
const found = await tools.search({path:written,query:"fresh"});
if (found.status !== "success" || found.data.matches.length !== 1) throw Error("Whole-file write target unavailable");
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
const changed = await tools.${operation}({path:source.data.matches.slice().reverse(),target:destination.data});
if (changed.status !== "success" || !changed.data.target) throw Error(JSON.stringify(changed));
const found = await tools.search({path:changed,query:"regex:ONE|TWO"});
if (found.status !== "success" || found.data.matches.length !== 2 || found.data.matches.some(m=>!m.source.endsWith("destination.txt"))) throw Error("Transfer result escaped the destination ranges");
const first = found.data.matches.filter(m=>m.range.startLine===1);
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
const changed = await tools.${operation}({path:[source.data.matches[0],source.data.matches[0]],target:point.data.target});
if (changed.status !== "success" || !changed.data.target) throw Error(JSON.stringify(changed));
const found = await tools.search({path:changed,query:"ONE"});
if (found.status !== "success" || found.data.matches.length !== 1 || found.data.matches[0].range.startColumn !== 5) throw Error("Zero-width target widened or lost coordinates");
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
const unequal = await tools.copy({path:source,target:destination.data.matches.slice(0,1)});
const overlap = await tools.move({path:source,target:source});
const forged = await tools.copy({path:"RESULT#forged",target:destination});
for (const refused of [unequal,overlap,forged]) if (refused.status !== "error" || refused.data.effect !== "not-applied" || refused.data.target) throw Error("Transfer guard granted authority");
const empty = await tools.copy({path:[],target:[]});
if (empty.status !== "success" || empty.data.effect !== "not-applied") throw Error("Empty pairing changed sources");
await tools.replace({path:"source.txt",start:"ONE",text:"NEW"});
await tools.flush({});
const stale = await tools.move({path:source,target:destination});
if (stale.status !== "error" || stale.data.effect !== "not-applied") throw Error("Stale transfer refreshed its scope");
text({unequal:unequal.status,overlap:overlap.status,forged:forged.status,empty:empty.data.effect,stale:stale.status});`,
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
if (changed.status !== "success" || changed.data.effect !== "pending" || !changed.data.target) throw Error("Legacy transfer did not reserve an output");
const final = await tools.flush({});
const source = final.data.files.find(file=>file.source.endsWith("source.txt"));
if (source?.effect !== ${JSON.stringify(operation === "copy" ? "not-applied" : "applied")}) throw Error("Transfer reported an incorrect source effect");
const found = await tools.search({path:changed,query:"ONE"});
if (found.status !== "success" || found.data.matches.length !== 1 || !found.data.matches[0].source.endsWith("destination.txt")) throw Error("Pending output included removals or neighbors");
text(await tools.replace({path:found,text:"NEW"}));`,
      ]);
      expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
        false,
      );
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
if (changed.status !== "success") throw Error(JSON.stringify(changed.errors));
text({effect:changed.data.effect});`,
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
if (removed.status !== "success" || removed.data.target !== undefined) throw Error("Delete published a live point or failed");
await tools.flush({});
const receipt = await tools.read({path:"removed.txt"});
if (receipt.data.lines[1].content !== "😀 ") throw Error("Delete widened its selected range");
text(removed);`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "removed.txt"), "utf8")).toBe(
      "keep\r\n😀 \r\nold outside",
    );
    const shown = getToolResultText(run, "compose-0");
    expect(shown).toContain('"removedText":"old"');
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
if (changed.status !== "success" || !changed.data.target) throw Error(JSON.stringify(changed));
const found = await tools.search({path:changed,query:"fresh"});
if (found.status !== "success" || found.data.matches.length !== 1 || !found.data.matches[0].source.endsWith("destination.txt")) throw Error("No destination scope");
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
await tools.flush({});
const window = await tools.read({path:"restore.txt",offset:2,limit:1});
const refused = await tools.undo({file:window,change:"last"});
if (refused.status !== "error" || refused.data.effect !== "not-applied") throw Error("Undo widened its input");
const whole = await tools.read({path:"restore.txt"});
const restored = await tools.undo({file:whole.data.target,change:"last"});
if (restored.status !== "success" || !restored.data.target) throw Error(JSON.stringify(restored));
const found = await tools.search({path:restored,query:"fresh"});
if (found.status !== "success" || found.data.matches.length !== 2) throw Error("Undo did not return the whole restored file");
text(restored); text(await tools.replace({path:found.data.matches.slice(0,1),text:"NEW"}));`,
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
      `const copied = await tools.copy({path:"source.bin",target:"copy.bin"});
if (copied.status !== "success" || copied.data.effect !== "applied" || copied.data.target || !copied.data.targetUnavailable) throw Error("Binary copy falsely granted text authority");
const refused = await tools.move({path:"source.bin",target:"existing.bin"});
if (refused.status !== "error" || refused.data.effect !== "not-applied" || refused.data.target) throw Error("Failed file move granted authority");
text({copy:copied.data.effect,targetUnavailable:copied.data.targetUnavailable,move:refused.data.effect});`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    for (const name of ["source.bin", "copy.bin", "existing.bin"])
      expect(await readFile(path.join(cwd, name))).toEqual(bytes);
  });
});

test("whole-file structured delete removes text, while a string path removes the file", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "whole.txt"), "😀 old\r\nneighbor");
    const run = await runComposition(cwd, "delete-whole-text-versus-file", [
      `const source = await tools.read({path:"whole.txt"});
const textRemoval = await tools.delete({path:source.data.target});
if (textRemoval.status !== "success" || textRemoval.data.target) throw Error("Structured delete unlinked its file or granted a point");
const empty = await tools.read({path:"whole.txt"});
if (empty.status !== "success" || empty.data.lines.some(line=>line.content!=="")) throw Error("Whole-file text removal did not preserve an empty file");
const noSource = await tools.replace({path:textRemoval,text:"BAD"});
if (noSource.status !== "error" || noSource.data.effect !== "not-applied") throw Error("Removal receipt was consumed as live text");
const fileRemoval = await tools.delete({path:"whole.txt"});
if (fileRemoval.status !== "success" || fileRemoval.data.target || fileRemoval.data.files[0].state !== "absent") throw Error("File deletion did not report absence");
text(fileRemoval);`,
    ]);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    await expect(readFile(path.join(cwd, "whole.txt"))).rejects.toThrow("ENOENT");
  });
});

test("Apply undo exposes restored files and reports restored absence without a live target", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "existing.txt"), "fresh before\r\nold body");
    const run = await runComposition(
      cwd,
      "apply-undo-restored-files-and-absence",
      [
        `const {transaction:receipt} = await tools.fixture_apply_receipt({});
const restored = await tools.undo({transaction:receipt});
if (restored.status !== "success" || !restored.data.target || restored.data.files.find(file=>file.source.endsWith("created.txt"))?.state !== "absent") throw Error(JSON.stringify(restored));
const found = await tools.search({path:restored,query:"fresh"});
if (found.status !== "success" || found.data.matches.length !== 1 || !found.data.matches[0].source.endsWith("existing.txt")) throw Error("Undo scope included an absent file or only the old diff range");
text(await tools.replace({path:found,text:"NEW"}));`,
      ],
      [path.resolve("tests/integration/support/apply-receipt-probe.ts")],
      [
        assistantMessage(
          [
            toolCall({
              id: "setup-apply",
              name: "apply",
              arguments: {
                source:
                  'const f = open("existing.txt"); f.replace(f.find("old body"), "new body"); createFile("created.txt", "temporary");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ],
    );
    expect(
      getToolExecution(run, "setup-apply").isError,
      getToolResultText(run, "setup-apply"),
    ).toBe(false);
    expect(getToolExecution(run, "compose-0").isError, getToolResultText(run, "compose-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "existing.txt"), "utf8")).toBe("NEW before\r\nold body");
    await expect(readFile(path.join(cwd, "created.txt"))).rejects.toThrow("ENOENT");
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
