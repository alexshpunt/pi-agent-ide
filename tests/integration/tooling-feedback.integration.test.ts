import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
  type AssistantMessageScenario,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const call = (id: string, name: string, args: Record<string, unknown>) =>
  assistantMessage(
    [
      toolCall({
        id,
        name,
        arguments: args,
        chunks: { kind: "explicit", chunks: [JSON.stringify(args)] },
      }),
    ],
    { stopReason: "toolUse" },
  );

async function run(cwd: string, name: string, conversation: AssistantMessageScenario[]) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({ codemode: { mode: "on" } }),
  );
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
  );
  return new PiIntegrationTest({
    cwd,
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: false,
    isolateUserResources: true,
    extensions: [
      path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
      path.resolve("src/pi-agent-ide.ts"),
      "builtin:codemode",
    ],
    tools: ["read", "search", "select", "replace", "insert", "delete", "codemode"],
    conversation: [...conversation, assistantMessage([text("Done")])],
  }).run("Use the issued source ranges and report the real effect.");
}

const consumers = [
  { name: "delete-uuid", tool: "delete", kind: "uuid", extra: {}, after: "first\nlast\n" },
  { name: "delete-item", tool: "delete", kind: "item", extra: {}, after: "first\nlast\n" },
  {
    name: "replace-item",
    tool: "replace",
    kind: "item",
    extra: { text: "NEW\n" },
    after: "first\nNEW\nlast\n",
  },
  {
    name: "insert-uuid",
    tool: "insert",
    kind: "uuid",
    extra: { text: "BEFORE", before: true },
    after: "first\nBEFORE\nOLD\nlast\n",
  },
] as const;

test.each(consumers)("direct $name consumes the model's issued reference", async (entry) => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "first\nOLD\nlast\n");
    const result = await run(cwd, `direct-issued-${entry.name}`, [
      call("selection", "select", {
        path: "note.txt",
        operation: { kind: "lines", first: 2, last: 2 },
      }),
      call("consume", entry.tool, { path: `$issued-${entry.kind}:selection`, ...entry.extra }),
    ]);
    expect(getToolExecution(result, "consume").isError, getToolResultText(result, "consume")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(entry.after);
  });
});

test.each(consumers)("batched direct $name keeps three independent selections", async (entry) => {
  await withTempWorkspace(async (cwd) => {
    for (const index of [1, 2, 3]) {
      await writeFile(path.join(cwd, `note-${index}.txt`), "first\nOLD\nlast\n");
    }
    const result = await run(cwd, `batched-issued-${entry.name}`, [
      ...[1, 2, 3].map((index) =>
        call(`selection${index}`, "select", {
          path: `note-${index}.txt`,
          operation: { kind: "lines", first: 2, last: 2 },
        }),
      ),
      assistantMessage(
        [1, 2, 3].map((index) => {
          const args = { path: `$issued-${entry.kind}:selection${index}`, ...entry.extra };
          return toolCall({
            id: `consume${index}`,
            name: entry.tool,
            arguments: args,
            chunks: { kind: "explicit", chunks: [JSON.stringify(args)] },
          });
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    for (const index of [1, 2, 3]) {
      expect(
        getToolExecution(result, `consume${index}`).isError,
        getToolResultText(result, `consume${index}`),
      ).toBe(false);
      expect(await readFile(path.join(cwd, `note-${index}.txt`), "utf8")).toBe(entry.after);
    }
  });
});
test("direct Search consumes a Read UUID without widening its window", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "note.txt"),
      "outside-feature\ninside-feature\noutside-feature\n",
    );
    const result = await run(cwd, "direct-issued-read-search", [
      call("window", "read", { path: "note.txt", offset: 2, limit: 1 }),
      call("inside", "search", { path: "$issued-uuid:window", query: "inside-feature" }),
      call("outside", "search", { path: "$issued-uuid:window", query: "outside-feature" }),
    ]);
    expect(getToolExecution(result, "inside").isError, getToolResultText(result, "inside")).toBe(
      false,
    );
    expect(getToolResultText(result, "inside")).toContain("inside-feature");
    expect(getToolExecution(result, "outside").isError, getToolResultText(result, "outside")).toBe(
      false,
    );
    expect(getToolResultText(result, "outside")).toContain("No matches found");
  });
});

test("direct Search evaluates Boolean colon terms inside issued windows", async () => {
  await withTempWorkspace(async (cwd) => {
    const feature = 'feature: "legacy​Checkout"';
    const original = `outside\n${feature}\noutside\n${feature}\n`;
    await writeFile(path.join(cwd, "note.txt"), original);
    const result = await run(cwd, "direct-issued-literal-colon", [
      call("window", "read", { path: "note.txt", offset: 2, limit: 1 }),
      call("inside", "search", { path: "$issued-uuid:window", query: feature }),
      call("unsupported", "search", { path: "$issued-uuid:window", query: "process:anything" }),
    ]);
    expect(getToolExecution(result, "inside").isError, getToolResultText(result, "inside")).toBe(
      false,
    );
    expect(getToolResultText(result, "inside")).toContain("1 match in 1 file");
    expect(getToolResultText(result, "inside")).toContain("legacy​Checkout");
    expect(getToolResultText(result, "inside")).not.toContain("note.txt:4:");
    expect(getToolExecution(result, "unsupported").isError).toBe(true);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(original);
  });
});
test("direct references reject a changed snapshot without deleting its file", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "first\nOLD\nlast\n");
    const result = await run(cwd, "direct-issued-stale", [
      call("selection", "select", {
        path: "note.txt",
        operation: { kind: "lines", first: 2, last: 2 },
      }),
      call("change", "replace", { path: "note.txt", start: "OLD", text: "NEW" }),
      call("stale", "delete", { path: "$issued-uuid:selection" }),
    ]);
    expect(getToolExecution(result, "change").isError).toBe(false);
    expect(getToolExecution(result, "stale").isError).toBe(true);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("first\nNEW\nlast\n");
  });
});

test("three sequential replacements report one file through native Codemode", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "OLD\nOLD\nOLD\n");
    const result = await run(cwd, "grouped-one-file", [
      call("script", "codemode", {
        code: `for (const line of [1,2,3]) { const selected = await tools.select({path:"note.txt",operation:{kind:"range",startLine:line,startColumn:0,endLine:line,endColumn:3}}); await tools.replace({path:selected,text:"NEW"}); } text("done");`,
      }),
    ]);
    expect(getToolExecution(result, "script").isError, getToolResultText(result, "script")).toBe(
      false,
    );
    expect(getToolResultText(result, "script")).toContain("Applied 3 replacements in 1 file.");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("NEW\nNEW\nNEW\n");
  });
});

test.each([false, true])(
  "Insert stopped before its payload preserves feedback (queued payload: %s)",
  async (queuedPayload) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
      const prefix = '{"path":"note.txt","anchor":"$issued-anchor:original:3","';
      const payload = 'text":"BLOCKED"}';
      const result = await run(cwd, `streamed-insert-before-payload-${queuedPayload}`, [
        call("original", "read", { path: "note.txt", views: ["anchors"] }),
        call("shift", "replace", { path: "note.txt", start: "beta", text: "beta\nadded" }),
        assistantMessage(
          [
            toolCall({
              id: "blocked",
              name: "insert",
              argumentsJson: queuedPayload ? prefix + payload : prefix,
              chunks: { kind: "explicit", chunks: queuedPayload ? [prefix, payload] : [prefix] },
              includeEnd: queuedPayload,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        call("current", "read", { path: "note.txt", views: ["anchors"] }),
        call("recovery", "insert", {
          path: "note.txt",
          anchor: "$issued-anchor:current:4",
          text: "recovered",
        }),
      ]);
      expect(getToolExecution(result, "shift").isError).toBe(false);
      expect(getToolExecution(result, "blocked").isError).toBe(true);
      expect(getToolResultText(result, "blocked")).toContain("is stale");
      expect(getToolResultText(result, "blocked")).not.toContain("Validation failed");
      expect(getToolResultMessage(result, "blocked").details).toMatchObject({
        effect: "not-applied",
      });
      expect(getToolResultText(result, "blocked")).toContain("4#");
      expect(JSON.stringify(result.messages)).not.toContain('"text":"BLOCKED"');
      expect(
        getToolExecution(result, "recovery").isError,
        getToolResultText(result, "recovery"),
      ).toBe(false);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
        "alpha\nbeta\nadded\ngamma\nrecovered",
      );
    });
  },
);

test.each([{}, { text: "" }])(
  "a complete Insert with invalid payload %j still fails validation",
  async (payload) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n");
      const result = await run(
        cwd,
        `complete-invalid-insert-${"text" in payload ? "empty" : "missing"}`,
        [call("invalid", "insert", { path: "note.txt", anchor: "alpha", ...payload })],
      );
      expect(getToolExecution(result, "invalid").isError).toBe(true);
      expect(getToolResultText(result, "invalid")).toContain("Validation failed");
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nbeta\n");
    });
  },
);
