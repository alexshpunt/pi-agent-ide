import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import {
  assistantMessage,
  getToolCallNames,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall as nativeToolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";

const root = path.resolve();
const extension = path.join(root, "tests/integration/composite/support/output-budget-ide.ts");

// Budget tests need complete arguments, not thousands of simulated typing deltas.
const toolCall = (input: Parameters<typeof nativeToolCall>[0]) =>
  nativeToolCall({ ...input, chunks: { kind: "fixed", size: 1000000 }, delayMs: 0 });

function usefulText(output: string): string {
  return (
    output
      .replace(/^<system-result[^\n]*>\n/u, "")
      .split("\n\n---\n\n# Guide:")[0]
      ?.split(
        /\n\n\[(?:Output truncated:|Showing lines|Output line|Line |First output line|No lines selected|Offset |\d+ more)/u,
      )[0] ?? ""
  );
}

function expectBounded(output: string) {
  const body = usefulText(output);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  expect(body.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
}

/** Check the actual provider requests, not only Pi's saved tool messages. */
async function expectProviderBudgets(result: Awaited<ReturnType<PiIntegrationTest["run"]>>) {
  let checked = 0;
  for (const request of result.providerRequests) {
    if (!Array.isArray(request.messages)) throw new Error("Provider messages are missing");
    const messages: unknown[] = request.messages;
    for (const message of messages) {
      if (
        message === null ||
        typeof message !== "object" ||
        !("role" in message) ||
        message.role !== "toolResult"
      )
        continue;
      if (!("content" in message) || !Array.isArray(message.content))
        throw new Error("Tool result content is missing");
      const content: unknown[] = message.content;
      const images = content.flatMap((block) => {
        if (
          block === null ||
          typeof block !== "object" ||
          !("type" in block) ||
          block.type !== "image"
        )
          return [];
        if (!("data" in block) || typeof block.data !== "string")
          throw new Error("Image data is missing");
        return [Buffer.from(block.data, "base64")];
      });
      expect(images.length).toBeLessThanOrEqual(20);
      expect(images.reduce((sum, image) => sum + image.byteLength, 0)).toBeLessThanOrEqual(
        20 * 1024 * 1024,
      );
      let pixels = 0;
      for (const image of images) {
        const decoded = await loadImage(image);
        pixels += decoded.width * decoded.height;
      }
      expect(pixels).toBeLessThanOrEqual(4_000_000);
      const text = content
        .flatMap((block) =>
          block !== null &&
          typeof block === "object" &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string"
            ? [block.text]
            : [],
        )
        .join("\n");
      expectBounded(text);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
}
/** Small fresh sessions keep stress payloads out of the scripted provider's compaction path. */
async function runBatches(
  options: ConstructorParameters<typeof PiIntegrationTest>[0],
  calls: ReturnType<typeof assistantMessage>[],
  batchSize = 8,
) {
  const runs: Awaited<ReturnType<PiIntegrationTest["run"]>>[] = [];
  for (let index = 0; index < calls.length; index += batchSize) {
    const result = await new PiIntegrationTest({
      ...options,
      testName: `${options.testName}-${index / batchSize}`,
      systemPrompt: "Execute the scripted tool checks.",
      conversation: [
        ...calls.slice(index, index + batchSize),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
    }).run("Exercise the IDE output safety barrier");
    await expectProviderBudgets(result);
    runs.push(result);
  }
  return (index: number) => {
    const run = runs[Math.floor(index / batchSize)];
    if (!run) throw new Error(`Missing batch for call ${index}`);
    return run;
  };
}
async function workspace() {
  const parent = path.join(root, ".tmp/output-budget");
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, "workspace-"));
}

test.each([undefined, 0, 1, 1999, 2000, 2001, 1000000])(
  "stresses Read limit %s with offsets, views, raw bytes and Diff ranges",
  async (limit) => {
    const cwd = await workspace();
    const source = Array.from(
      { length: 4000 },
      (_, index) => `const row_${index.toString().padStart(4, "0")} = "needle 😀";`,
    ).join("\n");
    const cases: { name: string; args: Record<string, unknown>; limit?: number }[] = [];
    for (const offset of [undefined, 0, -1, 3999, 5000]) {
      for (const views of [undefined, ["anchors"], ["ast"], ["anchors", "ast"]]) {
        cases.push({
          name: "read",
          args: {
            path: "large.ts",
            ...(limit === undefined ? {} : { limit }),
            ...(offset === undefined ? {} : { offset }),
            ...(views === undefined ? {} : { views }),
          },
          ...(limit === undefined ? {} : { limit }),
        });
      }
      cases.push({
        name: "read",
        args: {
          path: "raw:bytes.bin",
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
        },
        ...(limit === undefined ? {} : { limit }),
      });
    }
    cases.push({
      name: "read",
      args: { path: "data.json", views: ["jq:.[]"], ...(limit === undefined ? {} : { limit }) },
      ...(limit === undefined ? {} : { limit }),
    });
    cases.push({
      name: "diff",
      args: {
        before: { path: "large.ts", limit, views: ["anchors"] },
        after: { path: "other.ts", limit, views: ["anchors"] },
      },
    });
    try {
      await Promise.all([
        writeFile(path.join(cwd, "large.ts"), source),
        writeFile(path.join(cwd, "other.ts"), source.replaceAll("needle", "other")),
        writeFile(path.join(cwd, "bytes.bin"), Buffer.alloc(100000, 65)),
        writeFile(
          path.join(cwd, "data.json"),
          JSON.stringify(Array.from({ length: 4000 }, (_, index) => `row_${index}`)),
        ),
      ]);
      const resultFor = await runBatches(
        {
          testName: `read-limit-matrix-${limit ?? "default"}`,
          artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
          cwd,
          extensions: [extension, "builtin:codemode"],
          transport: "rpc",
          tools: ["read", "diff"],
          isolateUserResources: true,
        },
        cases.map(({ name, args }, index) =>
          assistantMessage([toolCall({ id: `range-${index}`, name, arguments: args })], {
            stopReason: "toolUse",
          }),
        ),
      );
      for (const [index, entry] of cases.entries()) {
        const result = resultFor(index);
        const message = getToolResultMessage(result, `range-${index}`);
        expect(message.isError, JSON.stringify(entry.args)).toBe(false);
        const output = getToolResultText(result, `range-${index}`);
        // Read continuation metadata is appended after useful content.
        const body =
          usefulText(output).split(
            /\n\n\[(?:Showing lines|Output truncated|Output line|Line |First output line|No lines selected|Offset |\d+ more)/u,
          )[0] ?? "";
        expectBounded(body);
        if (entry.name === "read" && entry.limit !== undefined && entry.args.path === "large.ts")
          expect((body.match(/row_\d+/gu) ?? []).length).toBeLessThanOrEqual(
            Math.max(0, entry.limit),
          );
        if (entry.args.path === "raw:bytes.bin") {
          const range = /Bytes (\d+)\.\.(\d+)/u.exec(body);
          expect(range).not.toBeNull();
          if (range && entry.limit !== undefined)
            expect(Number(range[2]) - Number(range[1])).toBeLessThanOrEqual(entry.limit);
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  210000,
);
test("bounds Search items across protocols, globs, generated files and composed scopes", async () => {
  const cwd = await workspace();
  const cases: Record<string, unknown>[] = [];
  for (const limit of [undefined, 1, 2, 79, 80, 81, 1000]) {
    for (const query of [
      "needle",
      "regex:needle",
      "needle AND item",
      "files:*.txt",
      "ast:const $NAME = $VALUE;",
    ]) {
      cases.push({ query, path: ".", ...(limit === undefined ? {} : { limit }) });
    }
    for (const caseSensitive of [false, true])
      for (const wholeWord of [false, true]) {
        cases.push({
          query: "needle",
          path: "generated",
          include: "*",
          exclude: "*.skip",
          caseSensitive,
          wholeWord,
          ...(limit === undefined ? {} : { limit }),
        });
      }
  }
  try {
    await mkdir(path.join(cwd, "generated"));
    await Promise.all(
      Array.from({ length: 1725 }, (_, index) =>
        writeFile(
          path.join(
            cwd,
            "generated",
            `${index.toString().padStart(4, "0")}-${"long-path-".repeat(8)}.txt`,
          ),
          Array.from({ length: index < 1489 ? 6 : 5 }, (_, line) => `needle item${line}`).join(
            "\n",
          ),
        ),
      ),
    );
    await writeFile(
      path.join(cwd, "large.ts"),
      Array.from({ length: 4000 }, (_, index) => `const value${index} = ${index};`).join("\n"),
    );
    const resultFor = await runBatches(
      {
        testName: "search-limit-matrix",
        artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
        cwd,
        extensions: [extension, "builtin:codemode"],
        transport: "rpc",
        tools: ["search", "read", "select", "codemode"],
        isolateUserResources: true,
      },
      [
        ...cases.map((args, index) =>
          assistantMessage([toolCall({ id: `search-${index}`, name: "search", arguments: args })], {
            stopReason: "toolUse",
          }),
        ),
        assistantMessage(
          [
            toolCall({
              id: "scoped-search",
              name: "codemode",
              arguments: {
                code: 'const result = await tools.search({ query: "needle", path: "generated", limit: 1 }); const tail = await tools.select({path:result,operation:{kind:"within",scopes:"generated/1724-"+ "long-path-".repeat(8)+".txt"}}); text(await tools.search({ query: "needle", path: tail, limit: 1 }));',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ],
    );
    for (const [index, args] of cases.entries()) {
      const result = resultFor(index);
      expect(getToolResultMessage(result, `search-${index}`).isError, JSON.stringify(args)).toBe(
        false,
      );
      const output = getToolResultText(result, `search-${index}`);
      expectBounded(output);
      if (args.query === "needle" || args.query === "regex:needle") {
        expect(output).toContain("10114 matches in 1725 files");
        const items =
          (output.match(/:line SEARCH#[A-F\d]+:\d+:match/gu) ?? []).length +
          (output.match(/\(compacted\)/gu) ?? []).length;
        expect(items).toBeLessThanOrEqual(Number(args.limit ?? 50));
        expect(items).toBeGreaterThan(0);
      }
    }
    const result = resultFor(cases.length);
    expect(getToolResultMessage(result, "scoped-search").isError).toBe(false);
    expect(getToolResultText(result, "scoped-search")).toContain("5 matches");
    expect(getToolResultText(result, "scoped-search")).toContain("1724-");
    expectBounded(getToolResultText(result, "scoped-search"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 210000);
test("stresses array scopes, verified anchors and annotation views without widening limits", async () => {
  const cwd = await workspace();
  try {
    for (const name of ["a", "b"])
      await writeFile(
        path.join(cwd, `${name}.ts`),
        Array.from(
          { length: 300 },
          (_, index) => `const needle_${name}_${index} = "${"value ".repeat(32)}${index}";`,
        ).join("\n"),
      );
    const code = `
      const source = (name) => Array.from({length:300},(_,index)=>'const needle_'+name+'_'+index+' = "'+"value ".repeat(32)+index+'";').join("\\n");
      const a = await tools.write({path:"a.ts",content:source("a")});
      const b = await tools.write({path:"b.ts",content:source("b")});
      if (source("a").length <= 51200) throw new Error("Scope fixture is too small");
      const combined = await tools.select({path:[a,b],operation:{kind:"merge"}});
      let checked = 0;
      const verify = (value, limit, resources) => {
        const body = value.replace(/^<system-result[^\\n]*>\\n/u,"").split("\\n\\n[Output truncated:")[0];
        const bytes = [...body].reduce((sum,char) => { const point=char.codePointAt(0); return sum+(point<=127?1:point<=2047?2:point<=65535?3:4); },0);
        if (bytes > 51200 || body.split("\\n").length > 2000) throw new Error("Useful output overflow");
        if ((body.match(/needle_[ab]_\\d+/gu)??[]).length > limit*resources) throw new Error("Explicit range overflow");
        checked++;
      };
      for (const offset of [-1,1,2]) for (const limit of [0,1,1000000]) {
        for (const views of [["anchors"],["ast"],["anchors","ast"],["diagnostics"],["breakpoints"]]) {
          verify(await tools.read({path:combined,offset,limit,views}),limit,2);
        }
      }
      const selected = await tools.read({path:"a.ts",offset:299,limit:1,views:["anchors"]});
      const anchor = /299#[A-F\\d]+/u.exec(selected)?.[0];
      if (!anchor) throw new Error("Verified source anchor is missing");
      for (const offset of [-1,0,1,2]) for (const limit of [0,1,1000000]) {
        verify(await tools.read({path:"a.ts#"+anchor,offset,limit,views:["anchors","ast"]}),limit,1);
      }
      text({checked});
    `;
    const result = await new PiIntegrationTest({
      testName: "scope-view-limit-matrix",
      cwd,
      artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
      extensions: [extension, "builtin:codemode"],
      transport: "rpc",
      isolateUserResources: true,
      tools: ["read", "write", "select", "codemode"],
      systemPrompt: "Execute the tool checks.",
      conversation: [
        assistantMessage([toolCall({ id: "scope-views", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
      timeoutMs: 90000,
    }).run("Stress exact source scopes and view combinations");
    await expectProviderBudgets(result);
    expect(getToolResultMessage(result, "scope-views").isError).toBe(false);
    expect(getToolResultText(result, "scope-views")).toMatch(/"checked"\s*:\s*57/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120000);
test("bounds terminal images and maximum-length sequences even with non-cropping offsets", async () => {
  const cwd = await workspace();
  const scripts = [
    'const launched = await tools.bash({command:"printf budget-frame; sleep 60",background:true,cols:300,rows:120}); const source=/session: (shell:[a-f\\d]+)/u.exec(launched)?.[1]; if (!source) throw new Error("Missing terminal source"); store("terminal",source); text(source);',
    'text(await tools.read({path:load("terminal"),views:["image:scale=1"],offset:0,limit:1}));',
    'text(await tools.read({path:load("terminal"),views:["sequence:duration=0.019,interval=0.001,scale=1"],offset:0,limit:1}));',
    'text(await tools.delete({path:load("terminal")}));',
  ];
  try {
    const result = await new PiIntegrationTest({
      testName: "terminal-media-budgets",
      cwd,
      artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
      extensions: [extension, "builtin:codemode"],
      transport: "rpc",
      isolateUserResources: true,
      tools: ["bash", "read", "delete", "codemode"],
      systemPrompt: "Execute the tool checks.",
      conversation: [
        ...scripts.map((code, index) =>
          assistantMessage(
            [toolCall({ id: `terminal-${index}`, name: "codemode", arguments: { code } })],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
      timeoutMs: 60000,
    }).run("Read large native terminal frames through the shared barrier");
    await expectProviderBudgets(result);
    for (const index of scripts.keys())
      expect(getToolResultMessage(result, `terminal-${index}`).isError).toBe(false);
    for (const index of [1, 2]) {
      const images = getToolResultMessage(result, `terminal-${index}`).content.filter(
        (block) => block.type === "image",
      );
      expect(images).toHaveLength(index === 1 ? 1 : 20);
      const pixels = await Promise.all(
        images.map(async (block) => {
          const image = await loadImage(Buffer.from(block.data, "base64"));
          expect(image.width).toBeGreaterThan(1);
          expect(image.height).toBeGreaterThan(1);
          return image.width * image.height;
        }),
      );
      expect(pixels.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(4_000_000);
      expect(
        images.reduce((sum, block) => sum + Buffer.byteLength(block.data, "base64"), 0),
      ).toBeLessThanOrEqual(20 * 1024 * 1024);
      expectBounded(getToolResultText(result, `terminal-${index}`));
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);
test("bounds Git change views and keeps large stage, unstage and undo effects complete", async () => {
  const cwd = await workspace();
  const git = (args: string[]) => promisify(execFile)("git", args, { cwd });
  const old = Array.from(
    { length: 300 },
    (_, index) => `old_${index}: ${"content ".repeat(24)}`,
  ).join("\n");
  expect(Buffer.byteLength(old)).toBeGreaterThan(DEFAULT_MAX_BYTES);
  try {
    await writeFile(path.join(cwd, "tracked.txt"), old);
    await git(["init", "-q"]);
    await git(["add", "tracked.txt"]);
    await git([
      "-c",
      "user.name=Budget test",
      "-c",
      "user.email=budget@example.invalid",
      "commit",
      "-qm",
      "Fixture",
    ]);
    await writeFile(path.join(cwd, "tracked.txt"), old.replaceAll("old_", "new_"));
    const result = await new PiIntegrationTest({
      testName: "git-output-budgets",
      cwd,
      artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
      extensions: [extension, "builtin:codemode"],
      transport: "rpc",
      isolateUserResources: true,
      tools: ["read", "stage", "unstage", "undo", "codemode"],
      systemPrompt: "Execute the tool checks.",
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "git-calls",
              name: "codemode",
              arguments: {
                code: 'for (const name of ["stage","unstage","undo"]) { const current=await tools.read({path:"tracked.txt",views:["changes","anchors"],limit:1}); const change=/CHANGE#[A-F\\d]+/u.exec(current)?.[0]; if (!change) throw new Error("No change anchor"); text(await tools[name]({file:"tracked.txt",change})); }',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
      timeoutMs: 60000,
    }).run("Stage and restore a complete large hunk behind bounded previews");
    await expectProviderBudgets(result);
    expect(getToolResultMessage(result, "git-calls").isError).toBe(false);
    expectBounded(getToolResultText(result, "git-calls"));
    expect(getToolCallNames(result)).toEqual(expect.arrayContaining(["stage", "unstage", "undo"]));
    expect((await readFile(path.join(cwd, "tracked.txt"), "utf8")) === old).toBe(true);
    expect((await git(["diff", "--cached", "--numstat"])).stdout).toBe("");
    expect((await git(["diff", "--numstat"])).stdout).toBe("");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);
test("keeps full mutation effects and selections behind bounded useful previews", async () => {
  const cwd = await workspace();
  const source = Array.from(
    { length: 4000 },
    (_, index) => `row_${index}: ${"content ".repeat(12)}`,
  ).join("\n");
  const scripts = [
    'const value = await tools.write({path:"large.txt",content:Array.from({length:4000}, (_,index)=>`row_${index}: ${"content ".repeat(12)}`).join("\\n")}); store("written",value); text(value);',
    'const selected = await tools.select({path:load("written"), operation:{kind:"lines",first:4000,last:4000}}); text(await tools.read({path:selected}));',
    'text(await tools.copy({path:"large.txt",target:"copy.txt"})); text(await tools.move({path:"copy.txt",target:"moved.txt"}));',
    'const replaced=await tools.replace({path:"moved.txt",start:"row_3999:",text:"last_row:"}); text(await tools.read({path:replaced,limit:1})); text(await tools.insert({path:"moved.txt",anchor:"last_row:",text:"inserted"}));',
    'text(await tools.undo({file:"moved.txt",change:"last"})); text(await tools.diff({before:"large.txt",after:"moved.txt"})); text(await tools.delete({path:"moved.txt"}));',
    'text(await tools.read({path:"large.txt",limit:1000000})); text(await tools.read({path:"large.txt",limit:1000000}));',
  ];
  try {
    const result = await new PiIntegrationTest({
      testName: "mutation-and-parent-budgets",
      cwd,
      artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
      extensions: [extension, "builtin:codemode"],
      transport: "rpc",
      isolateUserResources: true,
      tools: [
        "read",
        "write",
        "select",
        "copy",
        "move",
        "replace",
        "insert",
        "undo",
        "diff",
        "delete",
        "codemode",
      ],
      systemPrompt: "Execute the tool checks.",
      conversation: [
        ...scripts.map((code, index) =>
          assistantMessage(
            [
              toolCall({
                id: `success-${index}`,
                name: "codemode",
                arguments: { code: '// @options: {"max_output_tokens": 50000}\n' + code },
              }),
            ],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
      timeoutMs: 60000,
    }).run("Keep complete file edits while limiting their previews and parent output");
    await expectProviderBudgets(result);
    for (const index of scripts.keys()) {
      expect(getToolResultMessage(result, `success-${index}`).isError).toBe(false);
      expectBounded(getToolResultText(result, `success-${index}`));
    }
    expect(getToolResultText(result, "success-1")).toContain("row_3999:");
    expect(getToolResultText(result, "success-5")).toContain("Output truncated:");
    expect((await readFile(path.join(cwd, "large.txt"), "utf8")) === source).toBe(true);
    await expect(readFile(path.join(cwd, "copy.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(cwd, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(getToolCallNames(result)).toEqual(
      expect.arrayContaining([
        "write",
        "select",
        "read",
        "copy",
        "move",
        "replace",
        "insert",
        "undo",
        "diff",
        "delete",
      ]),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);
test("bounds real Read images and Codemode's aggregate forwarded media", async () => {
  const cwd = await workspace();
  try {
    await writeFile(path.join(cwd, "large.png"), await createCanvas(2100, 2100).encode("png"));
    const result = await new PiIntegrationTest({
      testName: "real-media-budgets",
      artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
      cwd,
      extensions: [extension, "builtin:codemode"],
      transport: "rpc",
      isolateUserResources: true,
      tools: ["read", "codemode"],
      systemPrompt: "Execute the tool checks.",
      conversation: [
        assistantMessage(
          [toolCall({ id: "image", name: "read", arguments: { path: "large.png" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "images",
              name: "codemode",
              arguments: {
                code: 'await Promise.all(Array.from({length:25}, () => tools.read({path:"large.png"}))); text("All image reads finished.");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
      timeoutMs: 60000,
    }).run("Read oversized images and forward many native image blocks");
    await expectProviderBudgets(result);
    for (const id of ["image", "images"]) {
      expect(getToolResultMessage(result, id).isError).toBe(false);
      const images = getToolResultMessage(result, id).content.filter(
        (block) => block.type === "image",
      );
      expect(images.length).toBe(id === "image" ? 1 : 20);
      const dimensions = await Promise.all(
        images.map(async (block) => {
          const decoded = await loadImage(Buffer.from(block.data, "base64"));
          return decoded.width * decoded.height;
        }),
      );
      expect(dimensions.reduce((sum, pixels) => sum + pixels, 0)).toBeLessThanOrEqual(4_000_000);
      expect(
        images.reduce((sum, block) => sum + Buffer.byteLength(block.data, "base64"), 0),
      ).toBeLessThanOrEqual(20 * 1024 * 1024);
      expectBounded(getToolResultText(result, id));
    }
    expect(getToolResultText(result, "images")).toContain("All image reads finished.");
    expect(getToolResultText(result, "images")).toContain("5 images omitted");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);
test("bounds LSP symbol discovery and reference navigation limits", async () => {
  const cwd = await workspace();
  try {
    const prefix = "budget_" + path.basename(cwd).replaceAll("-", "_");
    const declarations = Array.from(
      { length: 80 },
      (_, index) => `function ${prefix}_${index}() { return ${index}; } // ${"x".repeat(1000)}`,
    ).join("\n");
    expect(Buffer.byteLength(declarations)).toBeGreaterThan(DEFAULT_MAX_BYTES);
    // Long valid source paths stress result bytes without depending on provider name shortening.
    const source =
      Array.from({ length: 6 }, (_, index) => `nested_${index}_${"path".repeat(20)}`).join("/") +
      "/symbols.ts";
    await mkdir(path.dirname(path.join(cwd, source)), { recursive: true });
    await writeFile(path.join(cwd, source), declarations);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { noEmit: true, strict: true },
        include: ["**/*.ts"],
      }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/lsp-servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          typescript: {
            command: ["typescript-language-server", "--stdio"],
            rootMarkers: ["tsconfig.json"],
            languages: { typescript: { extensions: [".ts"] } },
            capabilities: ["diagnostics"],
          },
        },
      }),
    );
    const exact = `${prefix}_0`;
    await writeFile(
      path.join(cwd, "uses.ts"),
      Array.from({ length: 400 }, (_, index) => `const use_${index} = ${exact}();`).join("\n"),
    );
    const cases = [1, 80, 1000].flatMap((limit) => [
      { query: `symbols:${prefix}`, path: source, limit },
      { query: `symbols:${exact}`, path: source, limit, navigation: "references" as const },
    ]);
    const resultFor = await runBatches(
      {
        testName: "symbol-limit-matrix",
        cwd,
        artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
        extensions: [extension],
        transport: "rpc",
        isolateUserResources: true,
        tools: ["search"],
        timeoutMs: 60000,
      },
      cases.map((args, index) =>
        assistantMessage([toolCall({ id: `symbol-${index}`, name: "search", arguments: args })], {
          stopReason: "toolUse",
        }),
      ),
      3,
    );
    for (const [index, args] of cases.entries()) {
      const result = resultFor(index);
      const output = getToolResultText(result, `symbol-${index}`);
      expect(getToolResultMessage(result, `symbol-${index}`).isError, output).toBe(false);
      expect(output).not.toContain("No symbols found");
      expectBounded(output);
      expect((output.match(/SEARCH#[^\n]*:\d+:match /gu) ?? []).length).toBeLessThanOrEqual(
        args.limit,
      );
      if (args.navigation === "references" && args.limit > 1) expect(output).toContain("uses.ts");
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 150000);
test("stresses limits on HTTP text, process lists and terminal search", async () => {
  const cwd = await workspace();
  const body = Array.from(
    { length: 4000 },
    (_, index) => `needle ${index} ${"value ".repeat(20)}`,
  ).join("\n");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture has no port");
    const url = `http://127.0.0.1:${address.port}/source.txt`;
    const cases = [1, 80, 1000].flatMap((limit) => [
      { name: "read", arguments: { path: url, limit, offset: 1 } },
      { name: "read", arguments: { path: url, limit, offset: -1, views: ["anchors"] } },
      ...["needle", "regex:needle"].flatMap((query) =>
        [false, true].map((wholeWord) => ({
          name: "search",
          arguments: { query, path: url, limit, wholeWord, caseSensitive: true },
        })),
      ),
      { name: "search", arguments: { query: "process:node", limit } },
    ]);
    const resultFor = await runBatches(
      {
        testName: "resource-limit-matrix",
        cwd,
        artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
        extensions: [extension],
        transport: "rpc",
        isolateUserResources: true,
        tools: ["read", "search"],
      },
      cases.map((entry, index) =>
        assistantMessage([toolCall({ id: `resource-${index}`, ...entry })], {
          stopReason: "toolUse",
        }),
      ),
    );
    for (const [index, entry] of cases.entries()) {
      const result = resultFor(index);
      const output = getToolResultText(result, `resource-${index}`);
      expect(getToolResultMessage(result, `resource-${index}`).isError, output).toBe(false);
      expectBounded(output);
      if (entry.name === "search") {
        const count = entry.arguments.query?.startsWith("process:")
          ? (output.match(/^PID: /gmu) ?? []).length
          : Number(/^(\d+)\+? matches/mu.exec(usefulText(output))?.[1]);
        expect(count, output).toBeGreaterThan(0);
        expect(count, output).toBeLessThanOrEqual(entry.arguments.limit);
      }
    }
    const result = await new PiIntegrationTest({
      testName: "terminal-search-limits",
      cwd,
      artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
      extensions: [extension, "builtin:codemode"],
      transport: "rpc",
      isolateUserResources: true,
      tools: ["bash", "search", "delete", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "terminal-limits",
              name: "codemode",
              arguments: {
                code: `const started = await tools.bash({command:"for i in $(seq 1 4000); do echo needle-$i; done",timeoutSeconds:10});
          const source = /shell:[a-f\\d]+/.exec(started)?.[0];
          if (!source) throw new Error(started);
          for (const limit of [1,80,1000]) {
            const result = await tools.search({query:"needle",path:source,limit});
            const count = /(\\d+)\\+? match(?:es)? in/.exec(result)?.[1];
            if (count === undefined || Number(count) > limit) throw new Error(result);
            text(result);
          }
          await tools.delete({path:source});`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
    }).run("Bound terminal search output while preserving the complete log");
    await expectProviderBudgets(result);
    expect(
      getToolResultMessage(result, "terminal-limits").isError,
      getToolResultText(result, "terminal-limits"),
    ).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);
test("bounds malformed argument failures before they enter provider context", async () => {
  const cwd = await workspace();
  const payload = "😀".repeat(30000);
  const cases: Record<string, Record<string, unknown>> = {
    read: { path: [payload] },
    search: { query: [payload] },
    write: { path: "unused.txt", content: [payload] },
    replace: { path: "unused.txt", text: [payload] },
    insert: { path: "unused.txt", text: [payload] },
    delete: { path: [payload] },
    copy: { path: [payload], target: "unused.txt" },
    move: { path: [payload], target: "unused.txt" },
    diff: { before: { path: [payload] }, after: "unused.txt" },
    select: { path: "unused.txt", operation: { kind: payload } },
    undo: { file: "unused.txt", change: payload },
    stage: { file: "unused.txt", change: payload },
    unstage: { file: "unused.txt", change: payload },
    debug: { adapter: payload, program: [] },
    bash: { command: [payload] },
  };
  try {
    const resultFor = await runBatches(
      {
        testName: "argument-error-budgets",
        cwd,
        artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
        extensions: [extension, "builtin:codemode"],
        transport: "rpc",
        isolateUserResources: true,
        tools: [...Object.keys(cases), "codemode"],
      },
      Object.entries(cases).map(([name, args]) =>
        assistantMessage(
          [
            toolCall({
              id: `invalid-${name}`,
              name,
              arguments: args,
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      4,
    );
    for (const [index, name] of Object.keys(cases).entries()) {
      expect(getToolResultMessage(resultFor(index), `invalid-${name}`).isError, name).toBe(true);
      expect(getToolResultText(resultFor(index), `invalid-${name}`).length, name).toBeGreaterThan(
        0,
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);
for (const nested of [false, true]) {
  test(`bounds real oversized failures from every IDE tool (${nested ? "nested" : "direct"})`, async () => {
    const cwd = await workspace();
    const hugePath = "missing/" + "😀".repeat(30000);
    const cases: Record<string, Record<string, unknown>> = {
      read: { path: hugePath },
      search: { query: "needle", path: hugePath },
      write: { path: hugePath, content: "new" },
      replace: { path: hugePath, start: "needle", text: "new" },
      insert: { path: hugePath, anchor: "needle", text: "new" },
      delete: { path: hugePath },
      copy: { path: hugePath, target: "copy.txt" },
      move: { path: hugePath, target: "moved.txt" },
      diff: { before: hugePath, after: "small.txt" },
      select: { path: hugePath, operation: { kind: "lines", first: 1, last: 1 } },
      undo: { file: hugePath, change: "last" },
      stage: { file: hugePath, change: "CHANGE#ABCD" },
      unstage: { file: hugePath, change: "CHANGE#ABCD" },
      debug: { adapter: "debugpy", program: hugePath },
      bash: { command: "printf '%s' '" + "x".repeat(100000) + "'", timeoutSeconds: 10 },
    };
    try {
      await writeFile(path.join(cwd, "small.txt"), "small\n");
      const calls = Object.entries(cases).map(([name, args]) =>
        assistantMessage(
          [
            toolCall({
              id: `budget-${name}`,
              name: nested ? "codemode" : name,
              arguments: nested
                ? {
                    code: `try { text(await tools.${name}(${JSON.stringify(args)})); } catch (error) { text(String(error)); }`,
                  }
                : args,
            }),
          ],
          { stopReason: "toolUse" },
        ),
      );
      const resultFor = await runBatches(
        {
          testName: `all-tool-budgets-${nested}`,
          artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
          cwd,
          extensions: [extension, "builtin:codemode"],
          transport: "rpc",
          tools: [...Object.keys(cases), "codemode"],
          isolateUserResources: true,
        },
        calls,
        4,
      );
      const registered = JSON.parse(
        await readFile(path.join(cwd, "ide-tools.json"), "utf8"),
      ) as string[];
      expect(registered).toEqual(Object.keys(cases).sort());
      for (const [index, name] of Object.keys(cases).entries()) {
        const result = resultFor(index);
        const output = getToolResultText(result, `budget-${name}`);
        expect(output.length).toBeGreaterThan(0);
        expect(output).not.toContain("Tool codemode not found");
        expect(getToolCallNames(result)).toContain(name);
        if (nested)
          expect(getToolResultMessage(result, `budget-${name}`).isError, name).toBe(false);
        expectBounded(output);
        if (!nested && name !== "bash")
          expect(getToolResultMessage(result, `budget-${name}`).isError, name).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 150000);
}
