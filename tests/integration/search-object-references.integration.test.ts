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

interface Step {
  id: string;
  name: string;
  arguments: Record<string, JsonValue>;
}

async function run(cwd: string, name: string, steps: Step[]) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
  );
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    isolateUserResources: true,
    timeoutMs: 120_000,
    extensions: [
      path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
      path.resolve("src/pi-agent-ide.ts"),
    ],
    tools: ["read", "search", "replace", "insert", "delete", "copy", "move"],
    conversation: [
      ...steps.map((step) =>
        assistantMessage(
          [toolCall({ ...step, chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } })],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Reuse issued Search selectors without widening their selections.");
}

const selectors = [
  { token: "$issued-searchallline:scope", all: true, line: true },
  { token: "$issued-searchallmatch:scope", all: true, line: false },
  { token: "$issued-search:scope:1", all: false, line: true },
  { token: "$issued-searchmatch:scope:1", all: false, line: false },
];

test("Search selector objects and strings keep the same Read and Search scope", async () => {
  await withTempWorkspace(async (cwd) => {
    const original = "title first\nfeature legacyCheckout\ntitle final\n";
    await writeFile(path.join(cwd, "task.txt"), original);
    const steps: Step[] = [
      { id: "scope", name: "search", arguments: { path: "task.txt", query: "title" } },
    ];
    for (const [index, selector] of selectors.entries()) {
      for (const form of ["string", "object"]) {
        const source = form === "object" ? { id: selector.token } : selector.token;
        const id = `scope-${index}-${form}`;
        steps.push({ id, name: "read", arguments: { path: source } });
        for (const query of ["title", "first", "legacyCheckout"])
          steps.push({ id: `${id}-${query}`, name: "search", arguments: { path: source, query } });
      }
    }
    const result = await run(cwd, "search-object-read-scope", steps);
    for (const step of steps)
      expect(getToolExecution(result, step.id).isError, getToolResultText(result, step.id)).toBe(
        false,
      );
    for (const [index, selector] of selectors.entries()) {
      for (const form of ["string", "object"]) {
        const id = `scope-${index}-${form}`;
        const shown = getToolResultText(result, id);
        expect(shown).toContain("title");
        expect(shown).not.toContain("legacyCheckout");
        // Read displays containing lines; exact-match scope is checked by Search below.
        expect(shown).toContain("first");
        if (selector.all) expect(shown).toContain("final");
        else expect(shown).not.toContain("final");
        const withoutId = (output: string) => output.replace(/<uuid>[^<]+<\/uuid>/u, "<uuid/>");
        expect(withoutId(shown)).toBe(
          withoutId(getToolResultText(result, `scope-${index}-string`)),
        );
        for (const [query, count] of [
          ["title", selector.all ? 2 : 1],
          ["first", selector.line ? 1 : 0],
          ["legacyCheckout", 0],
        ] as const) {
          const details = getToolExecutionDetails(getToolExecution(result, `${id}-${query}`));
          expect(details).toMatchObject({ payload: { complete: true, matchCount: count } });
        }
      }
    }
    expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe(original);
  });
}, 180_000);

test("Search selector objects work as edit sources and anchors without granting preview authority", async () => {
  await withTempWorkspace(async (cwd) => {
    const original = "keep\nprefix OLD suffix\nlast\n";
    const steps: Step[] = [];
    const expected: Record<string, string> = {};
    for (const selector of ["all", "numbered"]) {
      for (const operation of ["replace", "insert", "delete", "copy", "move"] as const) {
        const id = `${operation}-${selector}`;
        const file = `${id}.txt`;
        await writeFile(path.join(cwd, file), original);
        steps.push({ id: `find-${id}`, name: "search", arguments: { path: file, query: "OLD" } });
        const reference = {
          id:
            selector === "all"
              ? `$issued-searchallmatch:find-${id}`
              : `$issued-searchmatch:find-${id}:1`,
        };
        const args: Record<string, JsonValue> = { path: reference };
        expected[file] = original;
        if (operation === "replace") {
          args.text = "NEW";
          expected[file] = original.replace("OLD", "NEW");
        } else if (operation === "insert") {
          // Exercise an object anchor as well as the object source path.
          args.before = reference;
          args.text = "ADDED";
          expected[file] = original.replace("OLD", "ADDEDOLD");
        } else if (operation === "delete") {
          args.at = reference;
          expected[file] = original.replace("OLD", "");
        } else {
          const target = `${id}-target.txt`;
          await writeFile(path.join(cwd, target), "left TARGET right\n");
          args.target = target;
          args.targetAt = "TARGET";
          expected[target] = "left OLD right\n";
          if (operation === "move") expected[file] = original.replace("OLD", "");
        }
        steps.push({ id, name: operation, arguments: args });
      }
    }
    await writeFile(path.join(cwd, "wrong.txt"), original);
    for (const [id, value] of [
      [
        "unknown",
        "SEARCH#FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:all:line",
      ],
      ["malformed", "SEARCH#ABCD:all:invalid"],
      ["path-id", "wrong.txt"],
    ] as const)
      steps.push({
        id: `refuse-${id}`,
        name: "replace",
        arguments: { path: { id: value }, text: "BAD" },
      });
    steps.push(
      { id: "find-tampered", name: "search", arguments: { path: "wrong.txt", query: "OLD" } },
      {
        id: "refuse-tampered",
        name: "replace",
        arguments: {
          path: { id: "$issued-searchallmatch:find-tampered", path: "wrong.txt", ranges: [] },
          text: "BAD",
        },
      },
    );
    const result = await run(cwd, "search-object-edit-scope", steps);
    for (const step of steps)
      expect(getToolExecution(result, step.id).isError, getToolResultText(result, step.id)).toBe(
        step.id.startsWith("refuse-"),
      );
    for (const [file, contents] of Object.entries(expected))
      expect(await readFile(path.join(cwd, file), "utf8"), file).toBe(contents);
    expect(await readFile(path.join(cwd, "wrong.txt"), "utf8")).toBe(original);
  });
}, 180_000);
