import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
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
                  'write({path: "note.txt", content: "alpha\\nbeta\\n"}); const doc = read({path: "note.txt"}); if (typeof doc.content !== "string") throw new Error("Expected raw text"); const line = doc.lines.find(line => line.content === "beta"); replace({path: doc.source, start: line.anchors[0], text: line.content.toUpperCase()});',
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
    expect(getToolExecutionDetails(execution)).toMatchObject({
      failed: false,
      files: [expect.stringContaining("note.txt")],
    });
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
                  'const found = await search({query: "beta", path: "note.txt", caseSensitive: true}); if (found.data.matches.length !== 1) throw new Error("Expected one raw match"); const edited = await replace({path: `SEARCH#${found.details.sessionId}:all:match`, text: "BETA"}); if(edited.metadata.searchObservations[0].matches !== 0) throw new Error("Expected refreshed search observation");',
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
              arguments: { source: 'await write({path:"empty.txt",content:""});' },
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
                  'let recovered = false; try { await replace({path:"note.txt",start:"beta",text:"BETA"}); } catch(error) { const recovery = error.details.recoveries[0]; if(recovery.candidates.length !== 2) throw new Error("Expected two candidates"); const doc = await read({path:recovery.path,offset:recovery.candidates[0].range.start.lineNumber,limit:1}); await replace({path:doc.source,start:doc.lines[0].anchors[0],text:"BETA"}); recovered = true; } if(!recovered) throw new Error("Expected ambiguity");',
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
                  'await replace({start:"alpha",text:"beta"}); await write({path:"second.txt",content:"beta\\n"}); await read({path:"second.txt"});',
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

test("Apply composes copy move remove and insert with standalone undo", async () => {
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
                  'await write({path:"source.txt",content:"a\\nb\\nc\\n"}); await write({path:"target.txt",content:"x\\n"}); await copy({path:"source.txt",start:"a",target:"target.txt",targetStart:"x"}); await move({path:"source.txt",start:"b",target:"target.txt",targetStart:"a"}); await remove({path:"source.txt",start:"a"}); await insert({path:"source.txt",anchor:"c",text:"d"});',
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
    }).run("Compose section edits then undo only the final insertion");
    for (const id of ["compose", "undo-last"]) {
      const execution = getToolExecution(run, id);
      expect(execution.isError, JSON.stringify(execution)).toBe(false);
    }
    expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("c\n");
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
                source: 'const doc = await read({path: "wide.txt"}); await result(doc.content);',
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

test("whole-file tools and Apply share file effects and overwrite refusals", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "original.bin"), Buffer.from([0, 255, 10]));
    const run = await new PiIntegrationTest({
      testName: "apply-file-operations",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply", "copy_file", "move_file", "delete_file"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "file-copy",
              name: "copy_file",
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
                  'let refused=false; try { copy_file({path:"original.bin",target:"copy.bin"}); } catch(e) { refused=e.code==="EEXIST"; } if(!refused) throw new Error("Expected refusal"); move_file({path:"copy.bin",target:"moved.bin"}); copy_file({path:"moved.bin",target:"last.bin"}); delete_file({path:"moved.bin"});',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "file-move",
              name: "move_file",
              arguments: { path: "last.bin", target: "final.bin" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "file-delete",
              name: "delete_file",
              arguments: { path: "original.bin" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Copy, move and delete files through both interfaces");
    for (const id of ["file-copy", "file-apply", "file-move", "file-delete"])
      expect(getToolExecution(run, id).isError).toBe(false);
    expect(await readFile(path.join(cwd, "final.bin"))).toEqual(Buffer.from([0, 255, 10]));
    for (const file of ["original.bin", "copy.bin", "moved.bin", "last.bin"])
      await expect(readFile(path.join(cwd, file))).rejects.toMatchObject({ code: "ENOENT" });
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
                  'const comparison=diff({before:{path:"before.txt",offset:2,limit:1},after:{path:"after.txt",offset:2,limit:1}}); if(comparison.equal || comparison.stats.added!==1 || comparison.stats.removed!==1) throw new Error("Wrong comparison"); result(comparison); const same=diff({before:"before.txt",after:"before.txt"}); if(!same.equal) throw new Error("Expected equality");',
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
                  'const doc = read({path: "raw:binary.bin"}); if (doc.kind !== "bytes" || JSON.stringify(doc.bytes) !== "[239,187,191,65,13,10,0,255]") throw new Error("Byte corruption"); result(doc); const tail = read({path: doc.source, offset: -2}); if (JSON.stringify(tail.bytes) !== "[0,255]") throw new Error("Bad byte offset");',
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

test("Apply shares stage unstage and undo with the Git changes module", async () => {
  await withTempWorkspace(async (cwd) => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git("init", "-q");
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n");
    git("add", "note.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
    const source = `replace({path:"note.txt",start:"beta",text:"BETA"});
      const doc = read({path:"note.txt",views:["changes"]});
      const anchor = JSON.stringify(doc).match(/CHANGE#[0-9A-F]+/)[0];
      const staged = stage({file:"note.txt",change:anchor});
      if(staged.state !== "staged") throw new Error("not staged");
      const unstaged = unstage({file:"note.txt",change:anchor});
      if(unstaged.state !== "unstaged") throw new Error("not unstaged");
      undo({file:"note.txt",change:"last"});
      if(read({path:"note.txt"}).content !== ${JSON.stringify("alpha\nbeta\n")}) throw new Error("undo failed");
      result({staged:staged.state,unstaged:unstaged.state});`;
    const run = await new PiIntegrationTest({
      testName: "apply-git-operations",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      environment: { IDE_HISTORY_EXPANDED: "0" },
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/restore-tool-history.ts"),
      ],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage([toolCall({ id: "git-ops", name: "apply", arguments: { source } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Edit, stage, unstage and undo through Apply");
    const execution = getToolExecution(run, "git-ops");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nbeta\n");
    expect(git("diff", "--cached")).toBe("");
    expect(git("diff")).toBe("");
  });
});

test("Apply keeps an index change when later script code fails", async () => {
  await withTempWorkspace(async (cwd) => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git("init", "-q");
    await writeFile(path.join(cwd, "note.txt"), "base\n");
    git("add", "note.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
    const source = `replace({path:"note.txt",start:"base",text:"changed"});
      const doc=read({path:"note.txt",views:["changes"]});
      const change=JSON.stringify(doc).match(/CHANGE#[0-9A-F]+/)[0];
      let caught=false; try { stage({file:"note.txt",change:"wrong"}); } catch(e) {caught=e.code==="INVALID_ARGUMENTS";}
      if(!caught) throw new Error("expected validation");
      stage({file:"note.txt",change});
      throw new Error("later script failure");`;
    const run = await new PiIntegrationTest({
      testName: "apply-index-retained",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      conversation: [
        assistantMessage([toolCall({ id: "retained", name: "apply", arguments: { source } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Keep a completed stage when later code fails");
    expect(getToolExecution(run, "retained").isError).toBe(true);
    expect(git("show", ":note.txt")).toBe("changed\n");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("changed\n");
  });
});
