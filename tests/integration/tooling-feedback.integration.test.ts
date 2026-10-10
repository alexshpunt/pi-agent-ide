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
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";
import { capabilityCases } from "#capabilities/cases.ts";

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

const sameFileEdits = [
  {
    tool: "replace",
    kind: "searchmatch",
    args: { text: "NEW" },
    after: "keep1\nNEW\nkeep2\nNEW\nkeep3\nNEW\n",
  },
  { tool: "delete", kind: "item", args: {}, after: "keep1\nkeep2\nkeep3\n" },
  { tool: "delete", kind: "search", args: {}, after: "keep1\nkeep2\nkeep3\n" },
  {
    tool: "insert",
    kind: "search",
    args: { text: "ADDED", before: true },
    after: "keep1\nADDED\nOLD\nkeep2\nADDED\nOLD\nkeep3\nADDED\nOLD\n",
  },
  {
    tool: "insert",
    kind: "item",
    args: { text: "ADDED", before: true },
    after: "keep1\nADDED\nOLD\nkeep2\nADDED\nOLD\nkeep3\nADDED\nOLD\n",
  },
] as const;

test.each(sameFileEdits)(
  "same-file direct $tool batch keeps every fresh $kind selection",
  async (entry) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), "keep1\nOLD\nkeep2\nOLD\nkeep3\nOLD\n");
      const selections =
        entry.kind === "search"
          ? [call("selection", "search", { path: "note.txt", query: "OLD" })]
          : [2, 4, 6].flatMap((line, index) =>
              entry.kind.startsWith("search")
                ? [
                    call(`window${index}`, "read", { path: "note.txt", offset: line, limit: 1 }),
                    call(`selection${index}`, "search", {
                      path: `$issued-uuid:window${index}`,
                      query: '"OLD"',
                    }),
                  ]
                : [
                    call(`selection${index}`, "select", {
                      path: "note.txt",
                      operation: { kind: "lines", first: line, last: line },
                    }),
                  ],
            );
      const reuse = entry.tool !== "delete";
      const result = await run(cwd, `same-file-issued-${entry.tool}-${entry.kind}`, [
        ...selections,
        assistantMessage(
          [0, 1, 2].map((index) => {
            const args = {
              path:
                entry.kind === "search"
                  ? `$issued-search:selection:${index + 1}`
                  : `$issued-${entry.kind}:selection${index}`,
              ...entry.args,
            };
            return toolCall({
              id: `consume${index}`,
              name: entry.tool,
              arguments: args,
              chunks: { kind: "explicit", chunks: [JSON.stringify(args)] },
            });
          }),
          { stopReason: "toolUse" },
        ),
        ...(reuse
          ? [0, 1, 2].flatMap((index) => [
              call(`reuse${index}`, "search", {
                path: `$issued-uuid:consume${index}`,
                query: entry.tool === "replace" ? "NEW" : "ADDED",
              }),
              call(`outside${index}`, "search", {
                path: `$issued-uuid:consume${index}`,
                query: "OLD OR keep",
              }),
            ])
          : []),
      ]);
      for (const index of [0, 1, 2]) {
        expect(
          getToolExecution(result, `consume${index}`).isError,
          getToolResultText(result, `consume${index}`),
        ).toBe(false);
        if (reuse) {
          for (const [prefix, matchCount] of [
            ["reuse", 1],
            ["outside", 0],
          ] as const) {
            const id = `${prefix}${index}`;
            expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
            expect(getToolResultMessage(result, id).details).toMatchObject({
              payload: { matchCount, complete: true },
            });
          }
        }
      }
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(entry.after);
      const events = result.traceEvents.flatMap((trace) =>
        "event" in trace && trace.event && typeof trace.event === "object"
          ? [trace.event as RunEvent]
          : [],
      );
      expect(
        validateRoute(
          {
            steps: [0, 1, 2].map((index) => ({
              tool: entry.tool,
              ...(index > 0 && { sameAssistantWith: 0 }),
            })),
          },
          events,
          "direct",
        ),
      ).toEqual({ passed: true, reasons: [] });
      if (entry.kind === "search") {
        const route = capabilityCases.find((item) => item.id === `search-line-batch-${entry.tool}`);
        if (!route) throw new Error("Missing numbered Search batch case");
        const inFixture = {
          ...route,
          steps: route.steps.map((step, index) =>
            index === 0 ? { ...step, args: { ...step.args, path: "note.txt" } } : step,
          ),
        };
        expect(validateRoute(inFixture, events, "direct")).toEqual({ passed: true, reasons: [] });
      }
      expect(result.tuiRenderedOutput).not.toContain("edit failed");
    });
  },
);

test("batch output selections preserve shifted ranges and empty replacement positions", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "keep1\nOLD\nkeep2\nOLD\nkeep3\nOLD\n");
    const batch = (prefix: string, values: readonly string[], issued: (index: number) => string) =>
      assistantMessage(
        values.map((value, index) =>
          toolCall({
            id: `${prefix}${index}`,
            name: "replace",
            arguments: { path: issued(index), text: value },
          }),
        ),
        { stopReason: "toolUse" },
      );
    const result = await run(cwd, "batch-result-positions", [
      call("selected", "search", { path: "note.txt", query: "OLD" }),
      batch("first", ["LONG", "", "Ω"], (index) => `$issued-searchmatch:selected:${index + 1}`),
      ...[0, 1, 2].map((index) =>
        call(`scope${index}`, "search", {
          path: `$issued-uuid:first${index}`,
          query: "LONG OR Ω OR OLD OR keep",
        }),
      ),
      batch("second", ["FINAL0", "FINAL1", "FINAL2"], (index) => `$issued-uuid:first${index}`),
    ]);
    for (const index of [0, 1, 2]) {
      for (const prefix of ["first", "scope", "second"]) {
        const id = `${prefix}${index}`;
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      }
      expect(getToolResultMessage(result, `scope${index}`).details).toMatchObject({
        payload: { matchCount: index === 1 ? 0 : 1, complete: true },
      });
    }
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
      "keep1\nFINAL0\nkeep2\nFINAL1\nkeep3\nFINAL2\n",
    );
  });
});
test("same-file selection batches reject overlaps and later reuse without losing valid peers", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "first\nmiddle\nlast\n");
    const result = await run(cwd, "selection-batch-guards", [
      call("first", "select", {
        path: "note.txt",
        operation: { kind: "lines", first: 1, last: 1 },
      }),
      call("last", "select", { path: "note.txt", operation: { kind: "lines", first: 3, last: 3 } }),
      assistantMessage(
        [
          toolCall({
            id: "accepted",
            name: "replace",
            arguments: { path: "$issued-item:first", text: "FIRST\n" },
          }),
          toolCall({ id: "overlap", name: "delete", arguments: { path: "$issued-item:first" } }),
          toolCall({
            id: "peer",
            name: "replace",
            arguments: { path: "$issued-item:last", text: "LAST\n" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      call("expired", "replace", { path: "$issued-item:last", text: "BAD\n" }),
    ]);
    expect(
      getToolExecution(result, "accepted").isError,
      getToolResultText(result, "accepted"),
    ).toBe(false);
    expect(getToolExecution(result, "peer").isError, getToolResultText(result, "peer")).toBe(false);
    expect(getToolExecution(result, "overlap").isError).toBe(true);
    expect(getToolResultText(result, "overlap")).toContain("overlaps");
    expect(getToolExecution(result, "expired").isError).toBe(true);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("FIRST\nmiddle\nLAST\n");
  });
});

test("issued Search line and match scopes stay sparse through direct calls and Codemode", async () => {
  await withTempWorkspace(async (cwd) => {
    const original =
      "title first\nfeature legacyCheckout\ntitle middle\nfeature legacyCheckout\ntitle final\n";
    await writeFile(path.join(cwd, "note.txt"), original);
    const scopes = [
      { kind: "searchallline", query: '"legacyCheckout"', count: 0 },
      { kind: "searchallline", query: '"title"', count: 3 },
      { kind: "search", query: '"first"', count: 1 },
      { kind: "searchmatch", query: '"first"', count: 0 },
      { kind: "searchallmatch", query: '"first"', count: 0 },
      { kind: "searchallmatch", query: '"title"', count: 3 },
      { kind: "uuid", query: '"title"', count: 3 },
    ];
    const result = await run(cwd, "search-reference-scopes", [
      call("titles", "search", { path: "note.txt", query: '"title"' }),
      ...scopes.map((scope, index) =>
        call(`direct${index}`, "search", {
          path: `$issued-${scope.kind}:titles`,
          query: scope.query,
        }),
      ),
      call("nested", "codemode", {
        code: scopes
          .map(
            (scope) =>
              `text(await tools.search(${JSON.stringify({ path: `$issued-${scope.kind}:titles`, query: scope.query })}));`,
          )
          .join("\n"),
      }),
    ]);
    for (const [index, scope] of scopes.entries()) {
      expect(
        getToolExecution(result, `direct${index}`).isError,
        getToolResultText(result, `direct${index}`),
      ).toBe(false);
      expect(getToolResultMessage(result, `direct${index}`).details).toMatchObject({
        payload: { matchCount: scope.count, complete: true },
      });
    }
    expect(getToolExecution(result, "nested").isError, getToolResultText(result, "nested")).toBe(
      false,
    );
    const events = result.traceEvents.flatMap((entry) =>
      "event" in entry && entry.event && typeof entry.event === "object"
        ? [entry.event as RunEvent]
        : [],
    );
    expect(
      validateRoute(
        {
          steps: scopes.map((scope) => ({
            tool: "search",
            args: { query: scope.query.slice(1, -1) },
            contains:
              scope.count === 0
                ? "No matches found"
                : `${scope.count} ${scope.count === 1 ? "match" : "matches"} in 1 file`,
          })),
        },
        events,
        "codemode",
      ),
    ).toEqual({ passed: true, reasons: [] });
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(original);
  });
});
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
