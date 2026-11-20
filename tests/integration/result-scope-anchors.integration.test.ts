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

test.each(["direct", "codemode"] as const)(
  "%s: result lists with explicit selectors refuse all mutations and can be retried without selectors",
  async (route) => {
    await withTempWorkspace(async (cwd) => {
      const original = "first\nmiddle\nlast\n";
      await writeFile(path.join(cwd, "task.txt"), original);
      const steps: { id: string; name: string; arguments: Record<string, JsonValue> }[] = [
        { id: "first", name: "search", arguments: { path: "task.txt", query: "first" } },
        { id: "last", name: "search", arguments: { path: "task.txt", query: "last" } },
      ];
      if (route === "direct") {
        for (const name of ["insert", "replace", "delete"]) {
          steps.push({
            id: name,
            name,
            arguments: {
              path: [{ id: "$issued-search:first:1" }, { id: "$issued-search:last:1" }],
              ...(name === "insert"
                ? { anchor: "$issued-search:first:1" }
                : { start: "$issued-search:first:1", end: "$issued-search:first:1" }),
              ...(name === "delete" ? {} : { newText: "BAD\n" }),
            },
          });
        }
        steps.push({
          id: "retry",
          name: "insert",
          arguments: {
            path: [{ id: "$issued-search:first:1" }, { id: "$issued-search:last:1" }],
            newText: "NEW\n",
          },
        });
      } else {
        steps.push({
          id: "code",
          name: "codemode",
          arguments: {
            code: `
const path = [{ id: "$issued-search:first:1" }, { id: "$issued-search:last:1" }];
const anchor = "$issued-search:first:1";
const refused = [];
refused.push(await tools.insert({ path, anchor, newText: "BAD\\n" }));
refused.push(await tools.replace({ path, start: anchor, end: anchor, newText: "BAD\\n" }));
refused.push(await tools.delete({ path, start: anchor, end: anchor }));
const retry = await tools.insert({ path, newText: "NEW\\n" });
text(JSON.stringify({ refused, retry: retry !== null }));
`,
          },
        });
      }
      const result = await run(
        cwd,
        `result-list-selectors-${route}`,
        steps,
        route === "direct" ? "tui" : "rpc",
      );
      if (route === "direct") {
        for (const id of ["insert", "replace", "delete"])
          expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(true);
        expect(getToolExecution(result, "retry").isError, getToolResultText(result, "retry")).toBe(
          false,
        );
      } else {
        expect(getToolExecution(result, "code").isError).toBe(false);
        expect(getToolResultText(result, "code")).toContain(
          JSON.stringify({ refused: [null, null, null], retry: true }),
        );
      }
      expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe(
        "first\nNEW\nmiddle\nlast\nNEW\n",
      );
    });
  },
);

test.each(["direct", "codemode"] as const)(
  "%s: the original Search result scopes an unchanged match after a sibling edit",
  async (route) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "task.txt"), "keep1\nOLD\nkeep2\nOLD\nkeep3\n");
      const result = await run(
        cwd,
        `surviving-search-scope-${route}`,
        route === "direct"
          ? [
              { id: "scope", name: "search", arguments: { path: "task.txt", query: "OLD" } },
              {
                id: "first",
                name: "replace",
                arguments: {
                  path: { id: "$issued-uuid:scope" },
                  start: "$issued-searchmatch:scope:1",
                  newText: "ONE",
                },
              },
              {
                id: "list",
                name: "replace",
                arguments: {
                  path: ["$issued-searchmatch:scope:1", "$issued-searchmatch:scope:2"],
                  newText: "BAD",
                },
              },
              {
                id: "stale",
                name: "replace",
                arguments: {
                  path: { id: "$issued-uuid:scope" },
                  start: "$issued-searchmatch:scope:1",
                  newText: "BAD",
                },
              },
              {
                id: "whole",
                name: "replace",
                arguments: {
                  path: { id: "$issued-uuid:scope" },
                  newText: "BAD",
                },
              },
              {
                id: "outside",
                name: "replace",
                arguments: {
                  path: { id: "$issued-uuid:scope" },
                  start: "keep2",
                  newText: "BAD",
                },
              },
              {
                id: "second",
                name: "replace",
                arguments: {
                  path: { id: "$issued-uuid:scope" },
                  start: "$issued-searchmatch:scope:2",
                  newText: "TWO",
                },
              },
            ]
          : [
              {
                id: "first-code",
                name: "codemode",
                arguments: {
                  code: `
const scope = await tools.search({ path: "task.txt", query: "OLD" });
store("scope", scope);
const first = await tools.replace({ path: scope, start: scope.matches[0], newText: "ONE" });
text(JSON.stringify({ first: first !== null }));
`,
                },
              },
              {
                id: "second-code",
                name: "codemode",
                arguments: {
                  code: `
const scope = load("scope");
const list = await tools.replace({ path: scope.matches, newText: "BAD" });
const stale = await tools.replace({ path: scope, start: scope.matches[0], newText: "BAD" });
const whole = await tools.replace({ path: scope, newText: "BAD" });
const outside = await tools.replace({ path: scope, start: "keep2", newText: "BAD" });
const second = await tools.replace({ path: scope, start: scope.matches[1], newText: "TWO" });
text(JSON.stringify({ list, stale, whole, outside, second: second !== null }));
`,
                },
              },
            ],
        route === "direct" ? "tui" : "rpc",
      );
      if (route === "direct") {
        for (const id of ["first", "second"])
          expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
        for (const id of ["list", "stale", "whole", "outside"])
          expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(true);
      } else {
        for (const id of ["first-code", "second-code"])
          expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
        expect(getToolResultText(result, "first-code")).toContain(JSON.stringify({ first: true }));
        expect(getToolResultText(result, "second-code")).toContain(
          JSON.stringify({ list: null, stale: null, whole: null, outside: null, second: true }),
        );
      }
      expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe(
        "keep1\nONE\nkeep2\nTWO\nkeep3\n",
      );
    });
  },
);

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
                arguments: { path: "$issued-uuid:scope", start: "last", newText: "BAD" },
              },
              {
                id: "retry",
                name: "replace",
                arguments: { path: "task.txt", start: "last", newText: "fixed" },
              },
            ]
          : [
              {
                id: "code",
                name: "codemode",
                arguments: {
                  code: `
const scope = await tools.read({ path: "task.txt", offset: 2, limit: 1 });
const miss = await tools.replace({ path: scope, start: "last", newText: "BAD" });
const retry = await tools.replace({ path: "task.txt", start: "last", newText: "fixed" });
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
                arguments: { path: "$issued-uuid:scope", start: "absent", newText: "BAD" },
              },
              {
                id: "blocked",
                name: "replace",
                arguments: { path: "task.txt", start: "last", newText: "BAD" },
              },
              {
                id: "recover",
                name: "replace",
                arguments: {
                  path: "task.txt",
                  start: "$issued-anchor:anchors:2",
                  newText: "NEW\n",
                },
              },
              {
                id: "retry",
                name: "replace",
                arguments: { path: "task.txt", start: "last", newText: "fixed" },
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
const miss = await tools.replace({ path: scope, start: "absent", newText: "BAD" });
const blocked = await tools.replace({ path: "task.txt", start: "last", newText: "BAD" });
const recover = await tools.replace({ path: "task.txt", start: anchor, newText: "NEW\n" });
text(JSON.stringify({ miss, blocked, recover: recover !== null }));
`,
                },
              },
              {
                id: "retry-code",
                name: "codemode",
                arguments: {
                  code: `
const retry = await tools.replace({ path: "task.txt", start: "last", newText: "fixed" });
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
const inserted = await tools.insert({ path: list, anchor: "two", newText: "\nADDED" });
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
