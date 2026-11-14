import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";

async function run(
  cwd: string,
  name: string,
  steps: { id: string; name: string; arguments: Record<string, JsonValue> }[],
  transport: "tui" | "rpc" = "rpc",
) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await mkdir(path.join(cwd, ".pi-agent"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    transport,
    rawMode: false,
    environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
    extensions: [
      path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
      path.resolve("src/pi-agent-ide.ts"),
      "builtin:codemode",
    ],
    tools: ["read", "search", "replace", "delete", "insert", "copy", "codemode"],
    conversation: [
      ...steps.map((step) =>
        assistantMessage([toolCall({ ...step, delayMs: 0 })], { stopReason: "toolUse" }),
      ),
      assistantMessage([text("Done", { delayMs: 0 })]),
    ],
  }).run("Edit inside results with selectors.");
}

test("direct edits resolve selectors inside the result passed as path", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "line.txt"), "First\nLast\n");
    await writeFile(path.join(cwd, "task.txt"), "value = 1\nvalue = 2\n");
    const result = await run(cwd, "result-scope-direct", [
      { id: "read", name: "read", arguments: { path: "line.txt", views: ["anchors"] } },
      { id: "first", name: "read", arguments: { path: "line.txt", offset: 1, limit: 1 } },
      {
        id: "outside",
        name: "delete",
        arguments: { path: { id: "$issued-uuid:first" }, start: "$issued-anchor:read:2" },
      },
      {
        id: "inside",
        name: "delete",
        arguments: { path: { id: "$issued-uuid:read" }, start: "$issued-anchor:read:2" },
      },
      { id: "second", name: "read", arguments: { path: "task.txt", offset: 2, limit: 1 } },
      {
        id: "unique-inside",
        name: "replace",
        arguments: { path: "$issued-uuid:second", start: "value", text: "other" },
      },
    ]);
    expect(getToolExecution(result, "outside").isError).toBe(true);
    expect(getToolResultText(result, "outside")).toContain(
      "outside the result's selection: line.txt line 1",
    );
    expect(getToolExecution(result, "inside").isError, getToolResultText(result, "inside")).toBe(
      false,
    );
    expect(
      getToolExecution(result, "unique-inside").isError,
      getToolResultText(result, "unique-inside"),
    ).toBe(false);
    expect(await readFile(path.join(cwd, "line.txt"), "utf8")).toBe("First\n");
    expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("value = 1\nother = 2\n");
  });
});

test.each(["direct", "codemode"] as const)(
  "%s: a scope-only exact miss leaves subsequent exact edits enabled",
  async (route) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "task.txt"), "keep\nOLD\nlast\n");
      const result = await run(
        cwd,
        `scope-only-exact-miss-${route}`,
        route === "direct"
          ? [
              { id: "scope", name: "read", arguments: { path: "task.txt", offset: 2, limit: 1 } },
              {
                id: "miss",
                name: "replace",
                arguments: { path: "$issued-uuid:scope", start: "last", text: "BAD" },
              },
              {
                id: "retry",
                name: "replace",
                arguments: { path: "task.txt", start: "last", text: "fixed" },
              },
            ]
          : [
              {
                id: "code",
                name: "codemode",
                arguments: {
                  code: `
const scope = await tools.read({ path: "task.txt", offset: 2, limit: 1 });
const miss = await tools.replace({ path: scope, start: "last", text: "BAD" });
const retry = await tools.replace({ path: "task.txt", start: "last", text: "fixed" });
text(JSON.stringify({ miss, retry: retry !== null }));
`,
                },
              },
            ],
        route === "direct" ? "tui" : "rpc",
      );
      if (route === "direct") {
        expect(getToolExecution(result, "miss").isError).toBe(true);
        expect(getToolExecution(result, "retry").isError, getToolResultText(result, "retry")).toBe(
          false,
        );
      } else {
        expect(getToolExecution(result, "code").isError).toBe(false);
        expect(getToolResultText(result, "code")).toContain(
          JSON.stringify({ miss: null, retry: true }),
        );
      }
      expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("keep\nOLD\nfixed\n");
    });
  },
);

test.each(["direct", "codemode"] as const)(
  "%s: an absent exact selector blocks retries until a returned anchor edits the file",
  async (route) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "task.txt"), "keep\nOLD\nlast\n");
      const result = await run(
        cwd,
        `absent-exact-miss-${route}`,
        route === "direct"
          ? [
              { id: "anchors", name: "read", arguments: { path: "task.txt", views: ["anchors"] } },
              { id: "scope", name: "read", arguments: { path: "task.txt", offset: 2, limit: 1 } },
              {
                id: "miss",
                name: "replace",
                arguments: { path: "$issued-uuid:scope", start: "absent", text: "BAD" },
              },
              {
                id: "blocked",
                name: "replace",
                arguments: { path: "task.txt", start: "last", text: "BAD" },
              },
              {
                id: "recover",
                name: "replace",
                arguments: { path: "task.txt", start: "$issued-anchor:anchors:2", text: "NEW\n" },
              },
              {
                id: "retry",
                name: "replace",
                arguments: { path: "task.txt", start: "last", text: "fixed" },
              },
            ]
          : [
              {
                id: "code",
                name: "codemode",
                arguments: {
                  code: String.raw`
const anchors = await tools.read({ path: "task.txt", views: ["anchors"] });
const anchor = anchors.text.split("\n")[1].split("|")[0];
const scope = await tools.read({ path: "task.txt", offset: 2, limit: 1 });
const miss = await tools.replace({ path: scope, start: "absent", text: "BAD" });
const blocked = await tools.replace({ path: "task.txt", start: "last", text: "BAD" });
const recover = await tools.replace({ path: "task.txt", start: anchor, text: "NEW\n" });
text(JSON.stringify({ miss, blocked, recover: recover !== null }));
`,
                },
              },
              {
                id: "retry-code",
                name: "codemode",
                arguments: {
                  code: `
const retry = await tools.replace({ path: "task.txt", start: "last", text: "fixed" });
text(JSON.stringify({ retry: retry !== null }));
`,
                },
              },
            ],
      );
      if (route === "direct") {
        for (const id of ["miss", "blocked"])
          expect(getToolExecution(result, id).isError).toBe(true);
        for (const id of ["recover", "retry"])
          expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      } else {
        expect(getToolExecution(result, "code").isError).toBe(false);
        expect(getToolResultText(result, "code")).toContain(
          JSON.stringify({ miss: null, blocked: null, recover: true }),
        );
        expect(getToolExecution(result, "retry-code").isError).toBe(false);
        expect(getToolResultText(result, "retry-code")).toContain(JSON.stringify({ retry: true }));
      }
      expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("keep\nNEW\nfixed\n");
    });
  },
);
test("Codemode passes results as path and values with an id as selectors", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "line.txt"), "First\nLast\n");
    await writeFile(path.join(cwd, "list.txt"), "one\ntwo\nthree\n");
    await writeFile(path.join(cwd, "source.txt"), "COPY_BEGIN body COPY_END\n");
    await writeFile(path.join(cwd, "target.txt"), "prefix TARGET_BEGIN old TARGET_END suffix\n");
    const result = await run(cwd, "result-scope-codemode", [
      {
        id: "code",
        name: "codemode",
        arguments: {
          code: String.raw`
const lines = await tools.read({ path: "line.txt", views: ["anchors"] });
const last = lines.text.split("\n")[1].split("|")[0];
const deleted = await tools.delete({ path: lines, start: last });
const list = await tools.read({ path: "list.txt" });
const inserted = await tools.insert({ path: list, anchor: "two", text: "ADDED\n" });
const begin = await tools.search({ path: "target.txt", query: "TARGET_BEGIN" });
const end = await tools.search({ path: "target.txt", query: "TARGET_END" });
const copied = await tools.copy({
  path: "source.txt",
  start: "COPY_BEGIN",
  end: "COPY_END",
  target: "target.txt",
  targetStart: begin.matches[0],
  targetEnd: { id: end.matches[0].id },
});
text(JSON.stringify({ deleted, inserted: inserted !== null, copied: copied !== null }));`,
        },
      },
    ]);
    const output = getToolResultText(result, "code");
    expect(getToolExecution(result, "code").isError, output).toBe(false);
    expect(codemodeFailures(output), output).toBe("");
    expect(output).toContain('{"deleted":null,"inserted":true,"copied":true}');
    expect(await readFile(path.join(cwd, "line.txt"), "utf8")).toBe("First\n");
    expect(await readFile(path.join(cwd, "list.txt"), "utf8")).toBe("one\ntwo\nADDED\nthree\n");
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe(
      "prefix COPY_BEGIN body COPY_END suffix\n",
    );
  });
});
