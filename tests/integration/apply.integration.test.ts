import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { createPdfFixture } from "#test-fixtures/pdf";

test("Apply composes the configured IDE read and mutation pipelines", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await new PiIntegrationTest({
      testName: "apply-read-replace",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "apply-edit",
              name: "apply",
              arguments: {
                source:
                  'createFile("note.txt", "alpha\\nbeta\\n"); createFile("other.txt", "one\\ntwo\\n"); flush(); const note = open("note.txt"); const other = open("other.txt"); note.replace(note.find("beta"), "BETA"); other.replace(other.find("one"), "ONE"); other.replace(other.find("two"), "TWO"); flush();',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Create a note and uppercase its beta line with Apply");
    const execution = getToolExecution(run, "apply-edit");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\n");
    expect(await readFile(path.join(cwd, "other.txt"), "utf8")).toBe("ONE\nTWO\n");
    expect(JSON.stringify(getToolExecutionDetails(execution))).toMatch(/APPLY#[0-9A-F]{12}/u);
    expect(getToolExecutionDetails(execution)).toMatchObject({
      failed: false,
      files: [expect.stringContaining("note.txt"), expect.stringContaining("other.txt")],
    });
  });
});

test("Apply completes 1,000 replacements in one large file", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = Array.from(
      { length: 11_000 },
      (_, index) => `const case_${String(index).padStart(5, "0")} = "legacyCheckout";\n`,
    ).join("");
    await writeFile(path.join(cwd, "cases.test.ts"), source);
    const run = await new PiIntegrationTest({
      testName: "apply-large-replacement-batch",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "large-apply",
              name: "apply",
              arguments: {
                source:
                  'const file = open("cases.test.ts"); file.replace(file.slice(file.find("legacyCheckout"), 0, 1000), "stableCheckout");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Replace the first 1,000 legacy names");
    const execution = getToolExecution(run, "large-apply");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    const final = await readFile(path.join(cwd, "cases.test.ts"), "utf8");
    expect(final.match(/stableCheckout/gu)).toHaveLength(1_000);
    expect(final.match(/legacyCheckout/gu)).toHaveLength(10_000);
    expect(Buffer.byteLength(JSON.stringify(execution.result.content))).toBeLessThanOrEqual(
      55 * 1024,
    );
  });
});

test("Apply moves a complete line block to a positional file end", async () => {
  await withTempWorkspace(async (cwd) => {
    const source =
      "keep-before\n// BEGIN serializes checkout-payload 0042\nblock line\n// END serializes checkout-payload 0042\nkeep-after\n";
    await writeFile(path.join(cwd, "source.test.ts"), source);
    await writeFile(path.join(cwd, "target.test.ts"), "target-one\ntarget-last");
    const run = await new PiIntegrationTest({
      testName: "apply-move-to-end",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "move-to-end",
              name: "apply",
              arguments: {
                source: `const source=open("source.test.ts");
const target=open("target.test.ts");
const block=source.between(
  "// BEGIN serializes checkout-payload 0042",
  "// END serializes checkout-payload 0042",
  {lines:true},
);
move(block,target.end());`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Move the marked test block to the end of the target file");
    const execution = getToolExecution(run, "move-to-end");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "source.test.ts"), "utf8")).toBe(
      "keep-before\nkeep-after\n",
    );
    expect(await readFile(path.join(cwd, "target.test.ts"), "utf8")).toBe(
      "target-one\ntarget-last\n// BEGIN serializes checkout-payload 0042\nblock line\n// END serializes checkout-payload 0042\n",
    );
  });
});
test("Apply supports symmetric text mutations and document flush", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "cases.test.ts"),
      "keep-1\ndelete-1\nkeep-2\ndelete-2\nkeep-3\ndelete-3\n",
    );
    const run = await new PiIntegrationTest({
      testName: "apply-document-symmetry",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "symmetric-remove",
              name: "apply",
              arguments: {
                source: `const file=open("cases.test.ts");
remove(file.line(2));
file.remove(file.line(4));
remove(file.line(6));
file.flush();`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Delete exactly three isolated test lines with Apply");
    const execution = getToolExecution(run, "symmetric-remove");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "cases.test.ts"), "utf8")).toBe(
      "keep-1\nkeep-2\nkeep-3\n",
    );
  });
});

test("Apply document delete runs staged edits before deleting the file", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "obsolete.txt"), "before\n");
    const run = await new PiIntegrationTest({
      testName: "apply-document-delete",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "document-delete",
              name: "apply",
              arguments: {
                source: `const file=open("obsolete.txt");
replace(file.find("before"), "after");
file.delete();`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Edit and delete an opened file with Apply");
    const execution = getToolExecution(run, "document-delete");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    await expect(readFile(path.join(cwd, "obsolete.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
test("Apply rejects an anchor-shaped literal when the structured resolver rejects it", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "anchor.txt"), "1#ABCD\n");
    const run = await new PiIntegrationTest({
      testName: "apply-exact-anchor-kind",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "exact-shaped",
              name: "apply",
              arguments: {
                source:
                  'const file=open("anchor.txt"); file.replace("1#ABCD", "literal"); flush();',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Reject stale structured anchor text without exact fallback");
    expect(getToolExecution(run, "exact-shaped").isError).toBe(false);
    expect(await readFile(path.join(cwd, "anchor.txt"), "utf8")).toBe("1#ABCD\n");
    expect(getToolResultText(run, "exact-shaped")).toContain("warning");
  });
});

test("Apply direct strings resolve line anchors before exact fallback", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n");
    const run = await new PiIntegrationTest({
      testName: "apply-anchor-parity",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "anchor-parity",
              name: "apply",
              arguments: {
                source:
                  'const shown=await read({path:"note.txt",views:["anchors"]}); const anchor=shown.lines?.[0]?.anchors?.[0]; if(!anchor) throw new Error("missing anchor"); const file=open("note.txt"); file.replace(anchor,"ALPHA"); file.replace("beta","BETA"); flush();',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Use a generated line anchor and exact fallback through Apply");
    const execution = getToolExecution(run, "anchor-parity");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("ALPHA\nBETA\n");
  });
});

test("Apply auto-commits pending multi-file edits on normal completion", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "a.txt"), "old\n");
    await writeFile(path.join(cwd, "b.txt"), "keep\n");
    const run = await new PiIntegrationTest({
      testName: "apply-auto-commit",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "auto",
              name: "apply",
              arguments: {
                source:
                  'const a=open("a.txt"); const b=open("b.txt"); a.replace("old","new"); b.replace("keep","kept");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Edit two files without a final explicit checkpoint");
    expect(getToolExecution(run, "auto").isError).toBe(false);
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("new\n");
    expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("kept\n");
  });
});

test("Apply does not commit pending edits when JavaScript throws", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "before\n");
    const run = await new PiIntegrationTest({
      testName: "apply-exception-no-commit",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "throwing",
              name: "apply",
              arguments: {
                source:
                  'const file=open("note.txt"); file.replace("before","after"); throw new Error("stop");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Stage an edit and throw before normal completion");
    expect(getToolExecution(run, "throwing").isError).toBe(true);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("before\n");
  });
});

test("Apply refreshes the same handle after a partial checkpoint", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "one two\n");
    const run = await new PiIntegrationTest({
      testName: "apply-refresh-handle",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "refresh",
              name: "apply",
              arguments: {
                source: String.raw`const file=open("note.txt"); const stale=file.find("one"); file.replace(stale,"ONE"); file.replace(file.line(1),"blocked\n"); const first=flush(); if(first.operations.map(x=>x.status).join(",")!=="applied,failed") throw new Error("wrong partial result"); let rejected=false; try { file.replace(stale,"bad"); } catch(error) { rejected=error.code==="STALE_SELECTION"; } if(!rejected) throw new Error("selection stayed current"); if(file.content!=="ONE two\n" || file.lines?.[0]?.content!=="ONE two") throw new Error("handle did not refresh"); file.replace("two","TWO");`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Correct a partial checkpoint with the same opened handle");
    expect(getToolExecution(run, "refresh").isError).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("ONE TWO\n");
  });
});

test("Apply with no pending mutations creates no transaction", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "same\n");
    const run = await new PiIntegrationTest({
      testName: "apply-no-op",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "no-op",
              name: "apply",
              arguments: {
                source: String.raw`const file=open("note.txt"); if(file.content!=="same\n") throw new Error("unexpected");`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Open a file without staging mutations");
    const execution = getToolExecution(run, "no-op");
    expect(execution.isError).toBe(false);
    expect(JSON.stringify(getToolExecutionDetails(execution))).not.toMatch(/APPLY#[0-9A-F]{12}/u);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("same\n");
  });
});

test("Apply mutates selection sets, copies text, and keeps an empty-set warning beside successful edits", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "source.txt"), "x x\nmissing-ish\n");
    await writeFile(path.join(cwd, "target.txt"), "slot slot\n");
    const run = await new PiIntegrationTest({
      testName: "apply-selection-sets",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "selection-sets",
              name: "apply",
              arguments: {
                source:
                  'const source=open("source.txt"); const target=open("target.txt"); source.replace(source.find("x"), "X"); copy(source.line(2), target.find("slot")); source.remove(source.find("missing-osh")); flush();',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Use SelectionSets and preserve an empty warning");
    const execution = getToolExecution(run, "selection-sets");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("X X\nmissing-ish\n");
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe(
      "missing-ish\n missing-ish\n\n",
    );
    const shown = getToolResultText(run, "selection-sets");
    expect(shown).toContain("warning");
    expect(shown).toMatch(/\d+#[A-F0-9]{4}/u);
  });
});
test("Apply hides precise text and Git helpers by default without hiding standalone tools", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\n");
    const hidden = [
      "replace",
      "insert",
      "remove",
      "editBatch",
      "undo",
      "stage",
      "unstage",
      "write",
      "delete_file",
      "copy_file",
      "move_file",
    ];
    const source = `for (const name of ${JSON.stringify(hidden)}) if (typeof globalThis[name] !== "undefined") throw new Error(name + " should be hidden");`;
    const run = await new PiIntegrationTest({
      testName: "apply-default-capabilities",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply", "replace"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [toolCall({ id: "default-capabilities", name: "apply", arguments: { source } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "standalone-replace",
              name: "replace",
              arguments: { path: "note.txt", start: "alpha", text: "beta" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Check default Apply capabilities and use standalone replace");
    expect(getToolExecution(run, "default-capabilities").isError).toBe(false);
    expect(getToolExecution(run, "standalone-replace").isError).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("beta\n");
  });
});
test("Apply reduces combined source reads and keeps the full output readable", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = `export function example() {\n${"  console.log(1);\n".repeat(1400)}}\n`;
    await Promise.all(
      ["first.ts", "second.ts"].map((name) => writeFile(path.join(cwd, name), source)),
    );
    const run = await new PiIntegrationTest({
      testName: "apply-combined-outline",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "apply-reads",
              name: "apply",
              arguments: {
                source: 'await read({path: "first.ts"}); await read({path: "second.ts"});',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read both source files with Apply");
    const execution = getToolExecution(run, "apply-reads");
    expect(execution.isError).toBe(false);
    expect(getToolExecutionDetails(execution)).toMatchObject({
      failed: false,
      outputLevel: "compact",
    });
    expect(
      (getToolExecutionDetails(execution) as { temporarySource: string }).temporarySource,
    ).toMatch(/^temp:/u);
  });
});

test("Apply search keeps raw matches and registers references for editing", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n");
    const run = await new PiIntegrationTest({
      testName: "apply-search-replace",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search-edit",
              name: "apply",
              arguments: {
                source:
                  'const found = search({query: "beta", path: "note.txt", caseSensitive: true}); if (found.data.matches.length !== 1) throw new Error("Expected one raw match"); const doc = open("note.txt"); doc.replace(doc.find("beta"), "BETA"); flush();',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Find and replace beta using a registered search selection");
    const execution = getToolExecution(run, "search-edit");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\n");
  });
});

test("Apply rejects explicitly unavailable diagnostics while ordinary script reads work", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\n");
    const run = await new PiIntegrationTest({
      testName: "apply-diagnostics-unavailable",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "diagnostics",
              name: "apply",
              arguments: {
                source:
                  'const doc = await read({path: "note.txt"}); if(doc.content !== "alpha\\n") throw new Error("Read failed"); for (const request of [{path: "diagnostics:note.txt"}, {path: "note.txt", views: ["diagnostics"]}]) { let caught = false; try { await read(request); } catch(error) { if(error.code !== "DIAGNOSTICS_UNAVAILABLE") throw error; caught = true; } if(!caught) throw new Error("Expected unavailable diagnostics"); }',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read text and check unavailable diagnostics explicitly");
    const execution = getToolExecution(run, "diagnostics");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
  });
});

test("Apply creates an empty file rather than treating it as an unchanged file", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await new PiIntegrationTest({
      testName: "apply-empty-create",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "empty",
              name: "apply",
              arguments: { source: 'createFile("empty.txt", ""); flush();' },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Create an empty file");
    const execution = getToolExecution(run, "empty");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "empty.txt"), "utf8")).toBe("");
  });
});

test("Apply returns structured candidates after ambiguous text selection", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "beta\nbeta\n");
    const run = await new PiIntegrationTest({
      testName: "apply-anchor-recovery",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "recovery",
              name: "apply",
              arguments: {
                source:
                  'const doc = open("note.txt"); if (doc.find("beta").length !== 2) throw new Error("Expected two matches"); doc.replace(doc.line(1), "BETA\\n"); flush();',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Recover from ambiguous text with structured candidates");
    const execution = getToolExecution(run, "recovery");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("BETA\nbeta\n");
  });
});

test("Apply and standalone edits share the last read source", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\n");
    const run = await new PiIntegrationTest({
      testName: "apply-read-context",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read", "apply", "replace"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [toolCall({ id: "read-first", name: "read", arguments: { path: "note.txt" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "inherit-in",
              name: "apply",
              arguments: {
                source:
                  'const note = open("note.txt"); note.replace(note.find("alpha"), "beta"); createFile("second.txt", "beta\\n"); flush(); read({path:"second.txt"});',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "inherit-out",
              name: "replace",
              arguments: { start: "beta", text: "gamma" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Share the last source across standalone and composed tools");
    for (const id of ["inherit-in", "inherit-out"]) {
      const execution = getToolExecution(run, id);
      expect(execution.isError, JSON.stringify(execution)).toBe(false);
    }
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("beta\n");
    expect(await readFile(path.join(cwd, "second.txt"), "utf8")).toBe("gamma\n");
  });
});

test("Apply restores the latest composed file edit with standalone undo", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await new PiIntegrationTest({
      testName: "apply-all-mutations",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply", "undo"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "compose",
              name: "apply",
              arguments: {
                source:
                  'createFile("source.txt", "a\\nb\\nc\\n"); createFile("target.txt", "x\\n"); flush(); const source = open("source.txt"); const target = open("target.txt"); const a = source.line(1); const b = source.line(2); source.remove(a); source.remove(b); source.insertAfter(source.find("c"), "\\nd"); target.insertAfter(target.find("x"), "\\n" + a.text.trim() + "\\n" + b.text.trim()); flush();',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "undo-last",
              name: "undo",
              arguments: { file: "source.txt", change: "last" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Compose section edits then undo the latest source-file edit");
    for (const id of ["compose", "undo-last"]) {
      const execution = getToolExecution(run, id);
      expect(execution.isError, JSON.stringify(execution)).toBe(false);
    }
    expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("a\nb\nc\n");
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("x\na\nb\n");
  });
});

test("Apply keeps long source visible when execution fails", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = `${Array.from({ length: 30 }, (_, index) => `// step ${index}`).join("\n")}\nthrow new Error("fixture failure");`;
    const run = await new PiIntegrationTest({
      testName: "apply-card-error",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage([toolCall({ id: "failure", name: "apply", arguments: { source } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Show a long composed call and its failure");
    expect(getToolExecution(run, "failure").isError).toBe(true);
    expect(run.tuiRenderedOutput).toContain("// step 0");
    expect(run.tuiRenderedOutput).toContain("// step 29");
  });
});

test("Apply presents long explicit and automatic reads through compact read panels", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "wide.txt"), "word ".repeat(2000));
    const run = await new PiIntegrationTest({
      testName: "apply-compact-read-panels",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "wide-read",
              name: "apply",
              arguments: {
                source: 'read({path: "wide.txt"});',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read wide text and select its raw content");
    expect(getToolExecution(run, "wide-read").isError).toBe(false);
    expect(await readFile(path.join(cwd, "wide.txt"), "utf8")).toBe("word ".repeat(2000));
  });
});

test("Apply optional diagnostics do not reject directory listings", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "listed.txt"), "content\n");
    await writeFile(path.join(cwd, "sample.pdf"), createPdfFixture(["converted-pdf-marker"]));
    const run = await new PiIntegrationTest({
      testName: "apply-directory-read",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "directory",
              name: "apply",
              arguments: {
                source:
                  'const doc = await read({path: "."}); if (!doc.content.includes("listed.txt")) throw new Error("Missing directory entry"); const pdf = await read({path: "sample.pdf"}); if (!pdf.content.includes("converted-pdf-marker")) throw new Error("Missing converted text");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read a directory with optional diagnostic enrichment");
    const execution = getToolExecution(run, "directory");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
  });
});

test("copy, move, and delete handle whole files without separate tools", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "original.bin"), Buffer.from([0, 255, 10]));
    const run = await new PiIntegrationTest({
      testName: "apply-file-operations",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply", "copy", "move", "delete"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "file-copy",
              name: "copy",
              arguments: { path: "original.bin", target: "copy.bin" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "file-apply",
              name: "apply",
              arguments: {
                source:
                  'moveFile("copy.bin", "moved.bin"); copyFile("moved.bin", "last.bin"); deleteFile("moved.bin"); flush();',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "file-move",
              name: "move",
              arguments: { path: "last.bin", target: "final.bin" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "file-delete",
              name: "delete",
              arguments: { path: "original.bin" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Copy, move and delete files through both interfaces");
    for (const id of ["file-copy", "file-apply", "file-move", "file-delete"]) {
      const execution = getToolExecution(run, id);
      expect(execution.isError, JSON.stringify(execution)).toBe(false);
    }
    expect(await readFile(path.join(cwd, "final.bin"))).toEqual(Buffer.from([0, 255, 10]));
    for (const file of ["original.bin", "copy.bin", "moved.bin", "last.bin"])
      await expect(readFile(path.join(cwd, file))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("Apply keeps independent edits when a create fails", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "before\n");
    await writeFile(path.join(cwd, "exists.txt"), "keep\n");
    const run = await new PiIntegrationTest({
      testName: "apply-partial-create",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "partial",
              name: "apply",
              arguments: {
                source:
                  'const note = open("note.txt"); note.replace(note.find("before"), "after"); createFile("exists.txt", "wrong\\n"); const outcome = flush(); if (outcome.operations[0].status !== "applied" || outcome.operations[1].status !== "failed") throw new Error("Wrong partial outcomes");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Apply an edit and report the failed create");
    const execution = getToolExecution(run, "partial");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("after\n");
    expect(await readFile(path.join(cwd, "exists.txt"), "utf8")).toBe("keep\n");
    expect(JSON.stringify(getToolExecutionDetails(execution))).toMatch(/APPLY#[0-9A-F]{12}/u);
  });
});

test("Apply rejects only the later overlapping edit and keeps snapshot offsets stable", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "one two three\n");
    const run = await new PiIntegrationTest({
      testName: "apply-partial-overlap",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "overlap",
              name: "apply",
              arguments: {
                source:
                  'const doc = open("note.txt"); doc.replace(doc.find("one"), "ONE-LONG"); doc.replace(doc.line(1), "rejected\\n"); doc.replace(doc.find("three"), "THREE"); const outcome = flush(); if (outcome.operations.map(({status}) => status).join(",") !== "applied,failed,applied") throw new Error("Wrong overlap outcomes");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Apply independent snapshot edits around an overlap");
    const execution = getToolExecution(run, "overlap");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("ONE-LONG two THREE\n");
  });
});

test("Apply keeps the first overlapping selection and rejects the later one", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha beta\n");
    const run = await new PiIntegrationTest({
      testName: "apply-overlap-selection",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "overlap-preflight",
              name: "apply",
              arguments: {
                source:
                  'const doc = open("note.txt"); doc.replace(doc.line(1), "line\\n"); doc.replace(doc.find("beta"), "BETA"); const outcome = flush(); if (outcome.operations[0].status !== "applied" || outcome.operations[1].status !== "failed") throw new Error("Wrong overlap outcomes");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Reject overlapping snapshot selections before writing");
    const execution = getToolExecution(run, "overlap-preflight");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("line\n");
  });
});
test("Apply preserves earlier file effects when a later operation fails", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "first.bin"), Buffer.from([1, 2, 3]));
    await writeFile(path.join(cwd, "second.bin"), Buffer.from([4, 5, 6]));
    await writeFile(path.join(cwd, "note.txt"), "before\n");
    const run = await new PiIntegrationTest({
      testName: "apply-file-rollback",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "rollback",
              name: "apply",
              arguments: {
                source:
                  'const note = open("note.txt"); note.replace(note.find("before"), "after"); copyFile("first.bin", "blocker"); moveFile("second.bin", "blocker/child"); const outcome = flush(); if (outcome.operations[2].status !== "failed") throw new Error("Expected failed move");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Rollback a transaction after a later filesystem operation fails");
    const execution = getToolExecution(run, "rollback");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "first.bin"))).toEqual(Buffer.from([1, 2, 3]));
    expect(await readFile(path.join(cwd, "second.bin"))).toEqual(Buffer.from([4, 5, 6]));
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("after\n");
    expect(await readFile(path.join(cwd, "blocker"))).toEqual(Buffer.from([1, 2, 3]));
  });
});
test("diff compares read sources and windows without editing either side", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "before.txt"), "alpha\nbeta\n");
    await writeFile(path.join(cwd, "after.txt"), "alpha\nBETA\n");
    const run = await new PiIntegrationTest({
      testName: "diff-read-sources",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["diff", "apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "compare",
              name: "diff",
              arguments: { before: "before.txt", after: "after.txt" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "compare-script",
              name: "apply",
              arguments: {
                source:
                  'const comparison=diff({before:{path:"before.txt",offset:2,limit:1},after:{path:"after.txt",offset:2,limit:1}}); if(comparison.equal || comparison.stats.added!==1 || comparison.stats.removed!==1) throw new Error("Wrong comparison"); const same=diff({before:"before.txt",after:"before.txt"}); if(!same.equal) throw new Error("Expected equality");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Compare two sources through standalone diff and Apply");
    for (const id of ["compare", "compare-script"])
      expect(getToolExecution(run, id).isError).toBe(false);
    expect(getToolExecutionDetails(getToolExecution(run, "compare-script"))).toHaveProperty(
      "display.comparisons.length",
      1,
    );
    expect(getToolExecutionDetails(getToolExecution(run, "compare-script"))).toHaveProperty(
      "files",
      [],
    );
    expect(getToolExecutionDetails(getToolExecution(run, "compare"))).toMatchObject({
      comparison: { kind: "diff", equal: false, stats: { added: 1, removed: 1 } },
    });
    expect(await readFile(path.join(cwd, "before.txt"), "utf8")).toBe("alpha\nbeta\n");
    expect(await readFile(path.join(cwd, "after.txt"), "utf8")).toBe("alpha\nBETA\n");
  });
});

test("diff uses converted text and keeps large comparisons complete behind bounded output", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "left.txt"), "left\n".repeat(2100));
    await writeFile(path.join(cwd, "right.txt"), "right\n".repeat(2100));
    await writeFile(path.join(cwd, "document.pdf"), createPdfFixture(["Comparable document"]));
    await writeFile(
      path.join(cwd, "image.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const run = await new PiIntegrationTest({
      testName: "diff-converted-overflow",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["diff", "apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "large-diff",
              name: "diff",
              arguments: { before: "left.txt", after: "right.txt" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "diff-data",
              name: "apply",
              arguments: {
                source:
                  'const full=diff({before:"left.txt",after:"right.txt"}); if(full.stats.added!==2100 || full.stats.removed!==2100 || full.before.content.length!==10500) throw new Error("Clipped comparison"); const pdf=diff({before:"document.pdf",after:"document.pdf"}); if(!pdf.equal) throw new Error("Converted text mismatch"); let rejected=false; try { diff({before:"image.png",after:"image.png"}); } catch(e) { rejected=e.code==="UNSUPPORTED_CONTENT"; } if(!rejected) throw new Error("Native image was not rejected");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Compare full text and converted sources");
    for (const id of ["large-diff", "diff-data"])
      expect(getToolExecution(run, id).isError).toBe(false);
    expect(getToolExecutionDetails(getToolExecution(run, "large-diff"))).toHaveProperty(
      "temporarySource",
      expect.stringMatching(/^temp:/),
    );
    expect(getToolExecutionDetails(getToolExecution(run, "large-diff"))).toMatchObject({
      comparison: { stats: { added: 2100, removed: 2100 } },
    });
  });
});

test("raw reads expose original bytes in standalone and Apply without text conversion", async () => {
  await withTempWorkspace(async (cwd) => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 65, 13, 10, 0, 255]);
    await writeFile(path.join(cwd, "binary.bin"), bytes);
    const run = await new PiIntegrationTest({
      testName: "apply-raw-bytes",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply", "read"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "raw-standalone",
              name: "read",
              arguments: { path: "raw:binary.bin", offset: -3, limit: 3 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "raw-apply",
              name: "apply",
              arguments: {
                source:
                  'const doc = read({path: "raw:binary.bin"}); if (doc.kind !== "bytes" || JSON.stringify(doc.bytes) !== "[239,187,191,65,13,10,0,255]") throw new Error("Byte corruption"); const tail = read({path: doc.source, offset: -2}); if (JSON.stringify(tail.bytes) !== "[0,255]") throw new Error("Bad byte offset");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Inspect original bytes through standalone read and Apply");
    for (const id of ["raw-standalone", "raw-apply"]) {
      const execution = getToolExecution(run, id);
      expect(execution.isError, JSON.stringify(execution)).toBe(false);
    }
    expect(getToolExecutionDetails(getToolExecution(run, "raw-standalone"))).toMatchObject({
      byteOffset: 5,
      byteLength: 3,
      totalBytes: 8,
    });
    expect(await readFile(path.join(cwd, "binary.bin"))).toEqual(bytes);
  });
});
