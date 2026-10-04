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

async function runAudit(cwd: string, name: string, calls: readonly ReturnType<typeof toolCall>[]) {
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
    cwd,
    rawMode: false,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
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
      "apply",
      "codemode",
    ],
    conversation: [
      ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
      assistantMessage([text("Apply parity audit finished.")]),
    ],
  }).run("Compare Apply with native tools, without invoking Apply from a replacement chain");
}

// These audit checks record current differences, including one known bug.
// They are evidence for the removal decision, not the desired replacement contract.
function expectSucceeded(run: Awaited<ReturnType<typeof runAudit>>, id: string) {
  expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
}

test("audit records different pending effects after an ordinary script error", async () => {
  await withTempWorkspace(async (cwd) => {
    for (const file of ["apply.txt", "native.txt"])
      await writeFile(path.join(cwd, file), "old\r\nprotected");
    const run = await runAudit(cwd, "parity-ordinary-error", [
      toolCall({
        id: "reference",
        name: "apply",
        arguments: {
          source:
            'const f=open("apply.txt"); f.replace("old","new"); throw Error("planned failure");',
        },
      }),
      toolCall({
        id: "native",
        name: "codemode",
        arguments: {
          code: 'const r=await tools.replace({path:"native.txt",start:"old",text:"new"}); if(r.data.effect!=="pending") throw Error("Expected pending edit"); text(r); throw Error("planned failure");',
        },
      }),
    ]);
    expect(getToolExecution(run, "reference").isError).toBe(true);
    expect(getToolExecution(run, "native").isError).toBe(true);
    expect(await readFile(path.join(cwd, "apply.txt"), "utf8")).toBe("old\r\nprotected");
    expect(await readFile(path.join(cwd, "native.txt"), "utf8")).toBe("new\r\nprotected");
  });
});

test("audit distinguishes create-only from create-or-overwrite", async () => {
  await withTempWorkspace(async (cwd) => {
    for (const file of ["apply.txt", "native.txt"])
      await writeFile(path.join(cwd, file), "protected\r\n");
    const run = await runAudit(cwd, "parity-create-only", [
      toolCall({
        id: "reference",
        name: "apply",
        arguments: { source: 'createFile("apply.txt","replacement\\r\\n");' },
      }),
      toolCall({
        id: "native",
        name: "codemode",
        arguments: {
          code: 'const r=await tools.write({path:"native.txt",content:"replacement\\r\\n"}); if(r.status!=="success") throw Error(JSON.stringify(r)); text(await tools.flush({}));',
        },
      }),
    ]);
    expect(getToolExecution(run, "reference").isError).toBe(true);
    expectSucceeded(run, "native");
    expect(await readFile(path.join(cwd, "apply.txt"), "utf8")).toBe("protected\r\n");
    expect(await readFile(path.join(cwd, "native.txt"), "utf8")).toBe("replacement\r\n");
  });
});

test("audit records the native empty-file creation receipt failure without hiding its actual effect", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await runAudit(cwd, "parity-empty-file-create", [
      toolCall({
        id: "reference",
        name: "apply",
        arguments: { source: 'createFile("apply-empty.txt","");' },
      }),
      toolCall({
        id: "native",
        name: "codemode",
        arguments: {
          code: 'text(await tools.write({path:"native-empty.txt",content:""})); text(await tools.flush({}));',
        },
      }),
    ]);
    expectSucceeded(run, "reference");
    expect(getToolExecution(run, "native").isError).toBe(true);
    expect(getToolResultText(run, "native")).toContain("Text changes must change the document.");
    expect(await readFile(path.join(cwd, "apply-empty.txt"), "utf8")).toBe("");
    expect(await readFile(path.join(cwd, "native-empty.txt"), "utf8")).toBe("");
  });
});

test("audit distinguishes concatenated broadcast from paired text copy", async () => {
  await withTempWorkspace(async (cwd) => {
    for (const prefix of ["apply", "native"]) {
      await writeFile(path.join(cwd, `${prefix}-source.txt`), "a-b\r\nprotected");
      await writeFile(path.join(cwd, `${prefix}-target.txt`), "x x\r\nprotected");
    }
    const run = await runAudit(cwd, "parity-copy-concatenation", [
      toolCall({
        id: "reference",
        name: "apply",
        arguments: {
          source:
            'const s=open("apply-source.txt"),d=open("apply-target.txt"); copy(s.union(s.find("a"),s.find("b")),d.find("x"));',
        },
      }),
      toolCall({
        id: "native",
        name: "codemode",
        arguments: {
          code: 'const s=await tools.search({path:"native-source.txt",query:"regex:[ab]"}); const d=await tools.search({path:"native-target.txt",query:"x"}); if(s.data.matches.length!==2||d.data.matches.length!==2) throw Error("Wrong source scopes"); const r=await tools.copy({path:s,target:d}); if(r.status!=="success") throw Error(JSON.stringify(r)); text(r);',
        },
      }),
    ]);
    expectSucceeded(run, "reference");
    expectSucceeded(run, "native");
    expect(await readFile(path.join(cwd, "apply-target.txt"), "utf8")).toBe("ab ab\r\nprotected");
    expect(await readFile(path.join(cwd, "native-target.txt"), "utf8")).toBe("a b\r\nprotected");
    for (const prefix of ["apply", "native"])
      expect(await readFile(path.join(cwd, `${prefix}-source.txt`), "utf8")).toBe(
        "a-b\r\nprotected",
      );
  });
});

test("audit composes create-only through a temporary file and non-overwriting copy", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "existing.txt"), "protected\r\n");
    const run = await runAudit(cwd, "parity-create-only-composition", [
      toolCall({
        id: "native",
        name: "codemode",
        arguments: {
          code: 'await tools.write({path:"owned-temp.txt",content:"replacement\\r\\n"}); const rejected=await tools.copy({path:"owned-temp.txt",target:"existing.txt"}); if(rejected.status!=="error"||rejected.data.effect!=="not-applied") throw Error(JSON.stringify(rejected)); await tools.delete({path:"owned-temp.txt"}); const prepared=await tools.write({path:"owned-temp.txt",content:"seed"}); if(prepared.status!=="success") throw Error(JSON.stringify(prepared)); const emptied=await tools.replace({path:prepared,text:""}); if(emptied.status!=="success") throw Error(JSON.stringify(emptied)); const created=await tools.copy({path:"owned-temp.txt",target:"created.txt"}); if(created.status!=="success"||created.data.effect!=="applied") throw Error(JSON.stringify(created)); await tools.delete({path:"owned-temp.txt"}); text({rejected:rejected.data.effect,created:created.data.effect});',
        },
      }),
    ]);
    expectSucceeded(run, "native");
    expect(await readFile(path.join(cwd, "existing.txt"), "utf8")).toBe("protected\r\n");
    expect(await readFile(path.join(cwd, "created.txt"), "utf8")).toBe("");
    await expect(readFile(path.join(cwd, "owned-temp.txt"))).rejects.toThrow("ENOENT");
  });
});

test("audit records grouped undo receipts only from the Apply checkpoint producer", async () => {
  await withTempWorkspace(async (cwd) => {
    for (const prefix of ["apply", "native"])
      for (const file of ["a", "b"])
        await writeFile(path.join(cwd, `${prefix}-${file}.txt`), "old\r\n");
    const run = await runAudit(cwd, "parity-grouped-undo", [
      toolCall({
        id: "reference",
        name: "apply",
        arguments: {
          source:
            'open("apply-a.txt").replace("old","new"); open("apply-b.txt").replace("old","new");',
        },
      }),
      toolCall({
        id: "native",
        name: "codemode",
        arguments: {
          code: 'await Promise.all([tools.replace({path:"native-a.txt",start:"old",text:"new"}),tools.replace({path:"native-b.txt",start:"old",text:"new"})]); const f=await tools.flush({}); if(f.status!=="success"||f.data.operations.length!==2||f.data.transaction!==undefined||f.data.transactions!==undefined) throw Error(JSON.stringify(f)); text(f);',
        },
      }),
    ]);
    expectSucceeded(run, "reference");
    expectSucceeded(run, "native");
    expect(getToolExecutionResult(run, "reference")).toMatchObject({
      structuredContent: { data: { transactions: [expect.stringMatching(/^APPLY#[0-9A-F]+$/u)] } },
    });
    for (const prefix of ["apply", "native"])
      for (const file of ["a", "b"])
        expect(await readFile(path.join(cwd, `${prefix}-${file}.txt`), "utf8")).toBe("new\r\n");
  });
});

test("audit distinguishes selective checkpoint effects when the script later throws", async () => {
  await withTempWorkspace(async (cwd) => {
    for (const prefix of ["apply", "native"])
      for (const file of ["a", "b"])
        await writeFile(path.join(cwd, `${prefix}-${file}.txt`), "old\r\n");
    const run = await runAudit(cwd, "parity-file-flush", [
      toolCall({
        id: "reference",
        name: "apply",
        arguments: {
          source:
            'const a=open("apply-a.txt"),b=open("apply-b.txt"); a.replace("old","new"); b.replace("old","new"); a.flush(); throw Error("planned failure");',
        },
      }),
      toolCall({
        id: "native",
        name: "codemode",
        arguments: {
          code: 'await Promise.all([tools.replace({path:"native-a.txt",start:"old",text:"new"}),tools.replace({path:"native-b.txt",start:"old",text:"new"})]); text(await tools.flush({})); throw Error("planned failure");',
        },
      }),
    ]);
    expect(getToolExecution(run, "reference").isError).toBe(true);
    expect(getToolExecution(run, "native").isError).toBe(true);
    expect(await readFile(path.join(cwd, "apply-a.txt"), "utf8")).toBe("new\r\n");
    expect(await readFile(path.join(cwd, "apply-b.txt"), "utf8")).toBe("old\r\n");
    for (const file of ["a", "b"])
      expect(await readFile(path.join(cwd, `native-${file}.txt`), "utf8")).toBe("new\r\n");
  });
});

test("audit replaces linewise insertion through guarded ordinary tools without fusing CRLF lines", async () => {
  await withTempWorkspace(async (cwd) => {
    for (const file of ["apply.txt", "native.txt"])
      await writeFile(path.join(cwd, file), "😀 first\r\nlast");
    const run = await runAudit(cwd, "parity-linewise-insert", [
      toolCall({
        id: "reference",
        name: "apply",
        arguments: {
          source:
            'const f=open("apply.txt"); f.insertAfter(f.end(),"NEW",{separation:"blank-line"});',
        },
      }),
      toolCall({
        id: "native",
        name: "codemode",
        arguments: {
          code: 'const r=await tools.insert({path:"native.txt",anchor:"last",text:"NEW",separation:"blank-line"}); if(r.status!=="success") throw Error(JSON.stringify(r)); text(r);',
        },
      }),
    ]);
    expectSucceeded(run, "reference");
    expectSucceeded(run, "native");
    expect(await readFile(path.join(cwd, "apply.txt"), "utf8")).toBe("😀 first\r\nlast\r\n\r\nNEW");
    expect(await readFile(path.join(cwd, "native.txt"), "utf8")).toBe(
      "😀 first\r\nlast\r\n\r\nNEW",
    );
  });
});
