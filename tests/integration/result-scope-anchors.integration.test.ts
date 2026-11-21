import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

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
    tools: ["read", "search", "replace", "delete", "insert", "copy", "move", "codemode"],
    conversation: [
      ...steps.map((step) =>
        assistantMessage([toolCall({ ...step, delayMs: 0 })], { stopReason: "toolUse" }),
      ),
      assistantMessage([text("Done", { delayMs: 0 })]),
    ],
  }).run("Edit inside results with selectors.");
}

test.each(["literal", "Search match reference"] as const)(
  "a direct edit uses the only %s end after its start",
  async (selector) => {
    await withTempWorkspace(async (cwd) => {
      const file = path.join(cwd, "task.txt");
      await writeFile(file, "close\nopen\nbody\nclose\nkeep\n");
      const steps: { id: string; name: string; arguments: Record<string, JsonValue> }[] = [
        { id: "read", name: "read", arguments: { path: "task.txt" } },
      ];
      if (selector !== "literal")
        steps.push({
          id: "end-matches",
          name: "search",
          arguments: { path: "task.txt", query: "close" },
        });
      steps.push({
        id: "edit",
        name: "replace",
        arguments: {
          path: "task.txt",
          from: "open",
          through: selector === "literal" ? "close" : "$issued-searchallmatch:end-matches",
          text: "new",
        },
      });
      const result = await run(
        cwd,
        `ordered-${selector === "literal" ? "literal" : "search"}-end`,
        steps,
        "tui",
      );
      expect(getToolExecution(result, "edit").isError, getToolResultText(result, "edit")).toBe(
        false,
      );
      await expect(readFile(file, "utf8")).resolves.toBe("close\nnew\nkeep\n");
    });
  },
);

test("an ordered pair stays inside the Read result and preserves CRLF", async () => {
  await withTempWorkspace(async (cwd) => {
    const file = path.join(cwd, "task.txt");
    await writeFile(file, "OPEN\r\nCLOSE\r\nCLOSE\r\nOPEN\r\nbody\r\nCLOSE\r\nkeep\r\n");
    const result = await run(cwd, "ordered-read-scope-end", [
      {
        id: "outside-end",
        name: "codemode",
        arguments: {
          code: `const scope = await tools.read({ path: "task.txt", offset: 2, limit: 4 });
await tools.replace({ path: scope, from: "OPEN", through: "CLOSE", text: "BAD" });`,
        },
      },
      {
        id: "inside-end",
        name: "codemode",
        arguments: {
          code: `const scope = await tools.read({ path: "task.txt", offset: 2, limit: 6 });
await tools.replace({ path: scope, from: "OPEN", through: "CLOSE", text: "new" });`,
        },
      },
    ]);
    expect(getToolExecutionDetails(getToolExecution(result, "outside-end"))).toMatchObject({
      calls: [{ status: "ok" }, { status: "error" }],
    });
    expect(getToolExecutionDetails(getToolExecution(result, "inside-end"))).toMatchObject({
      calls: [{ status: "ok" }, { status: "ok" }],
    });
    await expect(readFile(file, "utf8")).resolves.toBe("OPEN\r\nCLOSE\r\nCLOSE\r\nnew\r\nkeep\r\n");
  });
});

test.each(
  (["direct", "codemode"] as const).flatMap((route) =>
    [
      { label: "plain", joiner: "" },
      { label: "zero-width-space", joiner: "\u200b" },
    ].map((text) => ({ route, ...text })),
  ),
)(
  "$route: multi-range Search scopes accept their own and narrower selectors ($label)",
  async ({ route, joiner, label }) => {
    await withTempWorkspace(async (cwd) => {
      const old = `legacy${joiner}Checkout`;
      const replacement = `stable${joiner}Checkout`;
      const rows = Array.from({ length: 10 }, (_, index) => `    route-${index + 1} = ${old};\n`);
      const original = `header\n${rows.join("")}footer\n`;
      const narrowOriginal = original.replaceAll(
        `route-2 = ${old}`,
        `route-2 = legacy${joiner}Basket`,
      );
      const names = ["all-match", "all-line", "own-result", "narrow", "insert", "delete"] as const;
      for (const name of names)
        await writeFile(
          path.join(cwd, `${name}.txt`),
          name === "narrow" ? narrowOriginal : original,
        );
      const steps: { id: string; name: string; arguments: Record<string, JsonValue> }[] = [];
      for (const name of names) {
        steps.push({
          id: `scope-${name}`,
          name: "search",
          arguments: {
            path: `${name}.txt`,
            query: name === "narrow" ? `regex:legacy${joiner}(?:Checkout|Basket)` : old,
            limit: 20,
          },
        });
        if (name === "narrow")
          steps.push({
            id: "narrower",
            name: "search",
            arguments: { path: { id: "$issued-uuid:scope-narrow" }, query: old, limit: 20 },
          });
        const selector =
          name === "own-result"
            ? { id: "$issued-uuid:scope-own-result" }
            : name === "all-line"
              ? "$issued-searchallline:scope-all-line"
              : name === "narrow"
                ? "$issued-searchallmatch:narrower"
                : `$issued-searchallmatch:scope-${name}`;
        const tool = name === "insert" || name === "delete" ? name : "replace";
        const written = name === "all-line" ? "selected\n" : name === "insert" ? "!" : replacement;
        const args = {
          path: { id: `$issued-uuid:scope-${name}` },
          ...(tool === "insert"
            ? { after: selector }
            : tool === "delete"
              ? { at: selector }
              : { at: selector }),
          ...(name === "delete" ? {} : { text: written }),
        };
        steps.push({
          id: `edit-${name}`,
          name: route === "direct" ? tool : "codemode",
          arguments:
            route === "direct"
              ? args
              : {
                  code:
                    name === "own-result"
                      ? `const scope = await tools.search({ path: "own-result.txt", query: ${JSON.stringify(old)}, limit: 20 });\nawait tools.replace({ path: scope, at: scope, text: ${JSON.stringify(written)} });`
                      : `await tools.${tool}(${JSON.stringify(args)});`,
                },
        });
      }
      // The native TUI representation issues SEARCH references on both routes.
      const result = await run(cwd, `multi-range-search-scope-${route}-${label}`, steps, "tui");
      for (const name of names) {
        const id = `edit-${name}`;
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
        if (route === "codemode")
          expect(getToolExecutionDetails(getToolExecution(result, id))).toMatchObject({
            calls: Array.from({ length: name === "own-result" ? 2 : 1 }, () => ({ status: "ok" })),
          });
        const expected =
          name === "all-line"
            ? `header\n${"selected\n".repeat(10)}footer\n`
            : (name === "narrow" ? narrowOriginal : original).replaceAll(
                old,
                name === "insert" ? `${old}!` : name === "delete" ? "" : replacement,
              );
        expect(await readFile(path.join(cwd, `${name}.txt`), "utf8")).toBe(expected);
      }
    });
  },
);

test.each(["direct", "codemode"] as const)(
  "%s: Search scopes allow line anchors and Move while refusing gaps and cross-range pairs",
  async (route) => {
    await withTempWorkspace(async (cwd) => {
      const original =
        "header\n  legacy\u200bCheckout first\nmiddle\n  legacy\u200bCheckout second\nfooter\n";
      await writeFile(path.join(cwd, "source.txt"), original);
      await writeFile(path.join(cwd, "line.txt"), original);
      await writeFile(path.join(cwd, "target.txt"), "SLOT\n");
      const steps: { id: string; name: string; arguments: Record<string, JsonValue> }[] = [
        { id: "anchors", name: "read", arguments: { path: "source.txt", views: ["anchors"] } },
        {
          id: "scope",
          name: "search",
          arguments: { path: "source.txt", query: "legacy\u200bCheckout" },
        },
        { id: "line-anchors", name: "read", arguments: { path: "line.txt", views: ["anchors"] } },
        {
          id: "line-scope",
          name: "search",
          arguments: { path: "line.txt", query: "legacy\u200bCheckout" },
        },
      ];
      const attempts = [
        { id: "outside-text", start: "middle" },
        { id: "outside-line", start: "$issued-anchor:anchors:3" },
        {
          id: "cross-match",
          start: "$issued-searchmatch:scope:1",
          end: "$issued-searchmatch:scope:2",
        },
        { id: "cross-line", start: "$issued-anchor:anchors:2", end: "$issued-anchor:anchors:4" },
      ];
      for (const { id, ...selector } of attempts) {
        const args = {
          path: { id: "$issued-uuid:scope" },
          ...(selector.end === undefined
            ? { at: selector.start }
            : { from: selector.start, through: selector.end }),
          text: "BAD",
        };
        steps.push({
          id,
          name: route === "direct" ? "replace" : "codemode",
          arguments:
            route === "direct"
              ? args
              : {
                  code: `await tools.replace(${JSON.stringify(args)});`,
                },
        });
      }
      const edits: { id: string; name: string; args: Record<string, JsonValue> }[] = [
        {
          id: "line-replace",
          name: "replace",
          args: {
            path: { id: "$issued-uuid:line-scope" },
            at: "$issued-anchor:line-anchors:2",
            text: "selected\n",
          },
        },
        {
          id: "line-move",
          name: "move",
          args: {
            path: { id: "$issued-uuid:scope" },
            at: "$issued-anchor:anchors:2",
            target: "target.txt",
            targetFrom: "SLOT",
            targetThrough: "SLOT",
          },
        },
      ];
      for (const { id, name, args } of edits)
        steps.push({
          id,
          name: route === "direct" ? name : "codemode",
          arguments:
            route === "direct"
              ? args
              : {
                  code: `await tools.${name}(${JSON.stringify(args)});`,
                },
        });
      const result = await run(cwd, `search-scope-line-anchors-${route}`, steps, "tui");
      for (const { id } of attempts) {
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(
          route === "direct",
        );
        if (route === "codemode")
          expect(getToolExecutionDetails(getToolExecution(result, id))).toMatchObject({
            calls: [{ status: "error" }],
          });
      }
      for (const { id } of edits) {
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
        if (route === "codemode")
          expect(getToolExecutionDetails(getToolExecution(result, id))).toMatchObject({
            calls: [{ status: "ok" }],
          });
      }
      expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe(
        "header\nmiddle\n  legacy\u200bCheckout second\nfooter\n",
      );
      expect(await readFile(path.join(cwd, "line.txt"), "utf8")).toBe(
        "header\nselected\nmiddle\n  legacy\u200bCheckout second\nfooter\n",
      );
      expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe(
        "  legacy\u200bCheckout first\n",
      );
    });
  },
);

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
                ? { after: "$issued-search:first:1" }
                : name === "replace"
                  ? { from: "$issued-search:first:1", through: "$issued-search:first:1" }
                  : { from: "$issued-search:first:1", through: "$issued-search:first:1" }),
              ...(name === "delete" ? {} : { text: "BAD\n" }),
            },
          });
        }
        steps.push({
          id: "retry",
          name: "insert",
          arguments: {
            path: [{ id: "$issued-search:first:1" }, { id: "$issued-search:last:1" }],
            text: "NEW\n",
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
refused.push(await tools.insert({ path, after: anchor, text: "BAD\\n" }));
refused.push(await tools.replace({ path, from: anchor, through: anchor, text: "BAD\\n" }));
refused.push(await tools.delete({ path, from: anchor, through: anchor }));
const retry = await tools.insert({ path, text: "NEW\\n" });
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
                  at: "$issued-searchmatch:scope:1",
                  text: "ONE",
                },
              },
              {
                id: "list",
                name: "replace",
                arguments: {
                  path: ["$issued-searchmatch:scope:1", "$issued-searchmatch:scope:2"],
                  text: "BAD",
                },
              },
              {
                id: "stale",
                name: "replace",
                arguments: {
                  path: { id: "$issued-uuid:scope" },
                  at: "$issued-searchmatch:scope:1",
                  text: "BAD",
                },
              },
              {
                id: "whole",
                name: "replace",
                arguments: {
                  path: { id: "$issued-uuid:scope" },
                  text: "BAD",
                },
              },
              {
                id: "outside",
                name: "replace",
                arguments: {
                  path: { id: "$issued-uuid:scope" },
                  at: "keep2",
                  text: "BAD",
                },
              },
              {
                id: "second",
                name: "replace",
                arguments: {
                  path: { id: "$issued-uuid:scope" },
                  at: "$issued-searchmatch:scope:2",
                  text: "TWO",
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
const first = await tools.replace({ path: scope, at: scope.matches[0], text: "ONE" });
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
const list = await tools.replace({ path: scope.matches, text: "BAD" });
const stale = await tools.replace({ path: scope, at: scope.matches[0], text: "BAD" });
const whole = await tools.replace({ path: scope, text: "BAD" });
const outside = await tools.replace({ path: scope, at: "keep2", text: "BAD" });
const second = await tools.replace({ path: scope, at: scope.matches[1], text: "TWO" });
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
                arguments: { path: "$issued-uuid:scope", at: "last", text: "BAD" },
              },
              {
                id: "retry",
                name: "replace",
                arguments: { path: "task.txt", at: "last", text: "fixed" },
              },
            ]
          : [
              {
                id: "code",
                name: "codemode",
                arguments: {
                  code: `
const scope = await tools.read({ path: "task.txt", offset: 2, limit: 1 });
const miss = await tools.replace({ path: scope, at: "last", text: "BAD" });
const retry = await tools.replace({ path: "task.txt", at: "last", text: "fixed" });
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
  "%s: an absent exact selector leaves later exact and anchored edits enabled",
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
                arguments: { path: "$issued-uuid:scope", at: "absent", text: "BAD" },
              },
              {
                id: "exact",
                name: "replace",
                arguments: { path: "task.txt", at: "last", text: "intermediate" },
              },
              {
                id: "anchored",
                name: "replace",
                arguments: {
                  path: "task.txt",
                  at: "$issued-anchor:anchors:2",
                  text: "NEW\n",
                },
              },
              {
                id: "retry",
                name: "replace",
                arguments: { path: "task.txt", at: "intermediate", text: "fixed" },
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
const miss = await tools.replace({ path: scope, at: "absent", text: "BAD" });
const exact = await tools.replace({ path: "task.txt", at: "last", text: "intermediate" });
const anchored = await tools.replace({ path: "task.txt", at: anchor, text: "NEW\n" });
text(JSON.stringify({ miss, exact: exact !== null, anchored: anchored !== null }));
`,
                },
              },
              {
                id: "retry-code",
                name: "codemode",
                arguments: {
                  code: `
const retry = await tools.replace({ path: "task.txt", at: "intermediate", text: "fixed" });
text(JSON.stringify({ retry: retry !== null }));
`,
                },
              },
            ],
      );
      if (route === "direct") {
        expect(getToolExecution(result, "miss").isError).toBe(true);
        for (const id of ["exact", "anchored", "retry"])
          expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      } else {
        expect(getToolExecution(result, "code").isError).toBe(false);
        expect(getToolResultText(result, "code")).toContain(
          JSON.stringify({ miss: null, exact: true, anchored: true }),
        );
        expect(getToolExecution(result, "retry-code").isError).toBe(false);
        expect(getToolResultText(result, "retry-code")).toContain(JSON.stringify({ retry: true }));
      }
      expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("keep\nNEW\nfixed\n");
    });
  },
);
test.each(["direct", "codemode"] as const)(
  "%s: retry an ambiguous exact selector with the issued all-match reference",
  async (route) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "task.txt"), "inside OLD\noutside OLD\ninside OLD\n");
      const result = await run(
        cwd,
        `ambiguous-exact-all-match-${route}`,
        route === "direct"
          ? [
              { id: "scope", name: "search", arguments: { path: "task.txt", query: "inside OLD" } },
              {
                id: "ambiguous",
                name: "replace",
                arguments: { path: { id: "$issued-uuid:scope" }, at: "OLD", text: "NEW" },
              },
              {
                id: "retry",
                name: "replace",
                arguments: {
                  path: { id: "$issued-uuid:scope" },
                  at: "$issued-searchallmatch:ambiguous",
                  text: "NEW",
                },
              },
            ]
          : [
              {
                id: "ambiguous",
                name: "codemode",
                arguments: {
                  code: `
const scope = await tools.search({ path: "task.txt", query: "inside OLD" });
store("scope", scope);
const replaced = await tools.replace({ path: scope, at: "OLD", text: "NEW" });
text(JSON.stringify({ refused: replaced === null }));
`,
                },
              },
              {
                id: "retry",
                name: "codemode",
                arguments: {
                  code: `
const scope = load("scope");
const replaced = await tools.replace({ path: scope, at: "$issued-searchallmatch:ambiguous", text: "NEW" });
text(JSON.stringify({ replaced: replaced !== null }));
`,
                },
              },
            ],
        route === "direct" ? "tui" : "rpc",
      );
      const failure = getToolExecution(result, "ambiguous");
      const output = getToolResultText(result, "ambiguous");
      if (route === "direct") {
        expect(failure.isError, output).toBe(true);
        expect(getToolExecutionDetails(failure)).toMatchObject({ effect: "not-applied" });
      } else {
        expect(failure.isError, output).toBe(false);
        expect(output).toContain(JSON.stringify({ refused: true }));
        expect(getToolResultText(result, "retry")).toContain(JSON.stringify({ replaced: true }));
      }
      expect(output).toMatch(/SEARCH#[A-Fa-f\d]+:all:match\b/u);
      expect(getToolExecution(result, "retry").isError, getToolResultText(result, "retry")).toBe(
        false,
      );
      expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe(
        "inside NEW\noutside OLD\ninside NEW\n",
      );
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
const deleted = await tools.delete({ path: lines, at: last });
const list = await tools.read({ path: "list.txt" });
const inserted = await tools.insert({ path: list, after: "two", text: "ADDED\n" });
const begin = await tools.search({ path: "target.txt", query: "TARGET_BEGIN" });
const end = await tools.search({ path: "target.txt", query: "TARGET_END" });
const copied = await tools.copy({
  path: "source.txt",
  from: "COPY_BEGIN",
  through: "COPY_END",
  target: "target.txt",
  targetFrom: begin.matches[0],
  targetThrough: { id: end.matches[0].id },
});
text(JSON.stringify({ deleted, inserted: inserted !== null, copied: copied !== null }));`,
        },
      },
    ]);
    const output = getToolResultText(result, "code");
    expect(getToolExecution(result, "code").isError, output).toBe(false);
    expect(getToolExecutionDetails(getToolExecution(result, "code"))).toMatchObject({
      calls: Array.from({ length: 7 }, () => ({ status: "ok" })),
    });
    expect(output).toContain('{"deleted":null,"inserted":true,"copied":true}');
    expect(await readFile(path.join(cwd, "line.txt"), "utf8")).toBe("First\n");
    expect(await readFile(path.join(cwd, "list.txt"), "utf8")).toBe("one\ntwo\nADDED\nthree\n");
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe(
      "prefix COPY_BEGIN body COPY_END suffix\n",
    );
  });
});
