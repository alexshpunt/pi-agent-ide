import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { expect, test } from "vitest";

const extensions = [
  path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
  path.resolve("src/pi-agent-ide.ts"),
];
const turn = (id: string, name: string, args: Record<string, unknown>) =>
  assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });

async function fixture(cwd: string) {
  await writeFile(path.join(cwd, "note.txt"), "keep\nOLD\nlast\n");
  await writeFile(path.join(cwd, "target.txt"), "destination\n");
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
  );
}

const paths = {
  uuid: "$issued-uuid:selection",
  prefixed: "RESULT#$issued-uuid:selection",
  value: { id: "$issued-uuid:selection" },
  jsonValue: JSON.stringify({ id: "$issued-uuid:selection" }),
};

test.each(Object.entries(paths))(
  "stops a stale anchor before payload for a %s path and permits recovery",
  async (form, source) => {
    await withTempWorkspace(async (cwd) => {
      await fixture(cwd);
      const anchor = "$issued-anchor:selection:2" + (form === "jsonValue" ? "|OLD" : "");
      const prefix = `{"path":${JSON.stringify(source)},"after":${JSON.stringify(anchor)},`;
      const payload = '"text":"MUST_NOT_BE_INSERTED"}';
      const run = await new PiIntegrationTest({
        testName: `stale-result-path-${form}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        timeoutMs: 120_000,
        extensions,
        tools: ["read", "replace", "insert"],
        conversation: [
          turn("selection", "read", { path: "note.txt", views: ["anchors"] }),
          ...(form === "jsonValue"
            ? [
                turn("copied", "replace", {
                  path: source,
                  at: "$issued-anchor:selection:2|OLD",
                  text: "$issued-anchor:selection:2|NEW\n",
                }),
              ]
            : []),
          turn("change", "replace", { path: source, at: "OLD", text: "CHANGED" }),
          assistantMessage(
            [
              text("Attempt the stale insertion."),
              toolCall({
                id: "stale",
                name: "insert",
                argumentsJson: prefix + payload,
                chunks: { kind: "explicit", chunks: [prefix, payload] },
                delayMs: 20,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          turn("current", "read", { path: "note.txt", views: ["anchors"] }),
          turn("recovery", "insert", {
            path: "note.txt",
            after: "$issued-anchor:current:2",
            text: "RECOVERED\n",
          }),
          assistantMessage([text("Done")]),
        ],
      }).run("Reject a stale result-path anchor before its text arrives, then recover");
      expect(getToolExecution(run, "selection").isError).toBe(false);
      if (form === "jsonValue") expect(getToolExecution(run, "copied").isError).toBe(true);
      expect(getToolExecution(run, "change").isError).toBe(false);
      expect(getToolExecution(run, "stale").isError).toBe(true);
      expect(getToolResultMessage(run, "stale").details).toMatchObject({
        guardId: "stale-anchor",
        effect: "not-applied",
        stoppedEarly: true,
        field: "after",
      });
      expect(
        run.traceEvents.some((trace) => {
          if (
            trace.type !== "message_update" ||
            trace.event === null ||
            typeof trace.event !== "object"
          )
            return false;
          const update = (
            trace.event as { assistantMessageEvent?: { type?: unknown; delta?: unknown } }
          ).assistantMessageEvent;
          return (
            update?.type === "toolcall_delta" &&
            typeof update.delta === "string" &&
            update.delta.includes("MUST_NOT_BE_INSERTED")
          );
        }),
      ).toBe(false);
      expect(getToolExecution(run, "recovery").isError).toBe(false);
      expect(getToolResultMessage(run, "recovery").details).not.toHaveProperty("guardId");
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
        "keep\nCHANGED\nRECOVERED\nlast\n",
      );
    });
  },
);

test("rejects unknown keys in every edit selector without applying file effects", async () => {
  await withTempWorkspace(async (cwd) => {
    await fixture(cwd);
    const bad = { id: "$issued-uuid:selection", anchor: "unissued selector override" };
    const cases = [
      ["bad-path", "replace", { path: bad, text: "BAD" }],
      ["bad-at", "replace", { path: "note.txt", at: bad, text: "BAD" }],
      ["bad-through", "replace", { path: "note.txt", from: "keep", through: bad, text: "BAD" }],
      ["bad-anchor", "insert", { path: "note.txt", after: bad, text: "BAD" }],
      ["bad-target", "copy", { path: "note.txt", target: bad }],
      ["bad-target-start", "copy", { path: "note.txt", target: "target.txt", targetAfter: bad }],
      [
        "bad-target-end",
        "move",
        {
          path: "note.txt",
          target: "target.txt",
          targetFrom: "destination",
          targetThrough: bad,
        },
      ],
      ["bad-path-array", "delete", { path: [bad] }],
      ["bad-target-array", "copy", { path: "note.txt", target: [bad] }],
    ] as const;
    const run = await new PiIntegrationTest({
      testName: "unsupported-edit-selector-keys",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      timeoutMs: 120_000,
      extensions,
      tools: ["read", "replace", "insert", "copy", "move", "delete"],
      conversation: [
        turn("selection", "read", { path: "note.txt" }),
        ...cases.map(([id, name, args]) => turn(id, name, args)),
        assistantMessage([text("Done")]),
      ],
    }).run("Refuse unsupported selector object keys without modifying either file");
    for (const [id] of cases) {
      expect(getToolExecution(run, id).isError, id).toBe(true);
      expect(getToolResultMessage(run, id).details, id).toMatchObject({
        code: "INVALID_RESULT_VALUE",
        effect: "not-applied",
      });
    }
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("keep\nOLD\nlast\n");
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("destination\n");
  });
});

test.each(Object.entries(paths))(
  "inspection does not widen a %s selection",
  async (form, source) => {
    await withTempWorkspace(async (cwd) => {
      await fixture(cwd);
      const run = await new PiIntegrationTest({
        testName: `result-scope-preserved-${form}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        extensions,
        tools: ["read", "replace"],
        conversation: [
          turn("selection", "read", { path: "note.txt", offset: 2, limit: 1 }),
          turn("outside", "replace", { path: source, at: "keep", text: "BAD" }),
          turn("inside", "replace", { path: source, at: "OLD", text: "NEW" }),
          assistantMessage([text("Done")]),
        ],
      }).run("Retain the original result selection while inspecting anchors");
      expect(getToolExecution(run, "outside").isError).toBe(true);
      expect(getToolExecution(run, "inside").isError).toBe(false);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("keep\nNEW\nlast\n");
    });
  },
);

test("issued Codemode Read, Search, match, AST match and capture values remain editable", async () => {
  await withTempWorkspace(async (cwd) => {
    await fixture(cwd);
    await writeFile(path.join(cwd, "code.ts"), "function oldName() { return 7; }\n");
    const run = await new PiIntegrationTest({
      testName: "issued-codemode-values",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [...extensions, "builtin:codemode"],
      tools: ["read", "search", "ast_search", "replace", "codemode"],
      conversation: [
        turn("script", "codemode", {
          code: `
const requireValue = (value) => { if (value === null) throw new Error("Call failed"); return value; };
const read = requireValue(await tools.read({path: "note.txt", offset: 2, limit: 1}));
requireValue(await tools.replace({path: read, text: "READ\\n"}));
const list = requireValue(await tools.search({path: "note.txt", query: "READ"}));
requireValue(await tools.replace({path: list, text: "LIST"}));
const found = requireValue(await tools.search({path: "note.txt", query: "LIST"}));
requireValue(await tools.replace({path: "note.txt", at: found.matches[0], text: "MATCH"}));
const ast = requireValue(await tools.ast_search({path: "code.ts", pattern: "function $NAME() { return 7; }"}));
requireValue(await tools.replace({path: ast.matches[0], text: "function astName() { return 8; }"}));
const captures = requireValue(await tools.ast_search({path: "code.ts", pattern: "function $NAME() { return 8; }"}));
requireValue(await tools.replace({path: "code.ts", at: captures.matches[0].captures.NAME[0], text: "captureName"}));
`,
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Compose actual issued values through native Codemode");
    expect(getToolExecution(run, "script").isError).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("keep\nMATCH\nlast\n");
    expect(await readFile(path.join(cwd, "code.ts"), "utf8")).toBe(
      "function captureName() { return 8; }\n",
    );
  });
});
