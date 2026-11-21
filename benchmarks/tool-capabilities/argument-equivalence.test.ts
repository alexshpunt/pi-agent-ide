import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateFiles } from "./sandbox.ts";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type RouteStep, type RunEvent } from "./validation.ts";

for (const id of ["exact-eof-lf", "exact-eof-crlf", "exact-eof-unterminated", "insert-before"]) {
  void test(`${id}: outcome validation rejects boundary damage even when the literal route is valid`, async () => {
    const fixture = task(id);
    const root = await mkdtemp(path.join(os.tmpdir(), "capability-outcome-"));
    try {
      const initial = Object.fromEntries(
        Object.entries(fixture.files ?? {}).map(([name, value]) => [name, Buffer.from(value)]),
      );
      const expected = fixture.expected ?? {};
      for (const [name, value] of Object.entries(expected)) {
        assert.equal(typeof value, "string");
        await writeFile(path.join(root, name), value as string);
      }
      assert.deepEqual(await validateFiles(root, initial, expected), []);
      for (const [name, value] of Object.entries(expected)) {
        assert.ok(typeof value === "string");
        const damagedValues = [`\n${value}`, `${value}\n`, value.slice(1)];
        if (id === "insert-before" && name === "block.txt")
          damagedValues.push("left [α\r\nβ[ right\r\n");
        for (const damaged of damagedValues) {
          await writeFile(path.join(root, name), damaged);
          assert.ok((await validateFiles(root, initial, expected)).length > 0);
        }
        await writeFile(path.join(root, name), value);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
interface Call {
  tool: string;
  args: Record<string, unknown>;
  text?: string;
  value?: unknown;
  error?: boolean;
}
const result = "RESULT#11111111-aaaa-4aaa-8aaa-111111111111";
function events(calls: Call[], mode = "direct"): RunEvent[] {
  const entries: RunEvent[] = calls.flatMap((call, index) => [
    {
      type: "tool_execution_start",
      toolCallId: String(index),
      toolName: call.tool,
      args: call.args,
      ...(mode === "codemode" && { parentToolCallId: "script" }),
    },
    {
      type: "tool_execution_end",
      toolCallId: String(index),
      toolName: call.tool,
      isError: call.error ?? false,
      result: { content: [{ type: "text", text: call.text ?? "" }], structuredContent: call.value },
    },
  ]);
  return mode === "direct"
    ? entries
    : [
        { type: "tool_execution_start", toolCallId: "script", toolName: "codemode", args: {} },
        ...entries,
        { type: "tool_execution_end", toolCallId: "script", toolName: "codemode", isError: false },
      ];
}
function task(id: string) {
  const found = capabilityCases.find((entry) => entry.id === id);
  assert.ok(found);
  return found;
}
function passes(id: string, calls: Call[], mode = "direct") {
  return validateRoute(task(id), events(calls, mode), mode).passed;
}

for (const mode of ["direct", "codemode"]) {
  void test(`${mode}: debugger programs and working directories match the same fixture location`, () => {
    const launch = task("debug-controls").steps[0];
    assert.ok(launch);
    const route: RouteStep[] = [
      launch,
      { tool: "read", reuse: { from: 0, field: "path", kind: "debug" } },
    ];
    const read: Call = { tool: "read", args: { path: "debug:session-1" } };
    const debug = (program: string, cwd?: string): Call => ({
      tool: "debug",
      args: { program, adapter: "debugpy", backend: "native", ...(cwd !== undefined && { cwd }) },
      text: "debug:session-1",
    });
    for (const call of [
      debug("/workspace/fixture/task.py"),
      debug("./task.py", "/workspace/fixture"),
      debug("/workspace/fixture/task.py", "/tmp"),
    ]) {
      const retained = events([call, read], mode);
      const original = structuredClone(retained);
      assert.ok(validateRoute({ steps: route }, retained, mode).passed);
      assert.deepEqual(retained, original);
      assert.equal(validateRoute({ steps: route }, events([call], mode), mode).passed, false);
      assert.equal(validateRoute({ steps: route }, events([read], mode), mode).passed, false);
      assert.equal(
        validateRoute(
          { steps: route },
          events([call, { ...read, args: { path: "debug:other" } }], mode),
          mode,
        ).passed,
        false,
      );
    }
    for (const call of [debug("other.py"), debug("task.py", "/tmp"), debug("/tmp/task.py")])
      assert.equal(validateRoute({ steps: route }, events([call, read], mode), mode).passed, false);
    const cwdRoute: RouteStep[] = [{ tool: "bash", args: { command: "pwd", cwd: "." } }];
    for (const cwd of [".", "./", "/workspace/fixture", "/workspace/fixture/"])
      assert.ok(
        validateRoute(
          { steps: cwdRoute },
          events([{ tool: "bash", args: { command: "pwd", cwd } }], mode),
          mode,
        ).passed,
      );
    assert.equal(
      validateRoute(
        { steps: cwdRoute },
        events([{ tool: "bash", args: { command: "pwd", cwd: "/tmp" } }], mode),
        mode,
      ).passed,
      false,
    );
  });
  void test(`${mode}: an anchored source Read resolves the launched program from its cwd`, () => {
    const route: RouteStep[] = [
      { tool: "debug", args: { program: "task.py" } },
      {
        tool: "read",
        args: { path: /^debug:[a-z0-9-]+\/source$/u, views: ["anchors"] },
        after: [0],
      },
    ];
    const read: Call = {
      tool: "read",
      args: { path: "/workspace/fixture/task.py", views: ["anchors"] },
    };
    const launch: Call = {
      tool: "debug",
      args: { program: "fixture/task.py", cwd: "/workspace" },
      text: "debug:session-1",
    };
    assert.ok(validateRoute({ steps: route }, events([launch, read], mode), mode).passed);
    for (const path of ["/workspace/task.py", "/workspace/fixture/fixture/task.py"])
      assert.equal(
        validateRoute(
          { steps: route },
          events([launch, { ...read, args: { ...read.args, path } }], mode),
          mode,
        ).passed,
        false,
      );
  });
  void test(`${mode}: the breakpoints view accepts the launched source file without dropping the view`, () => {
    const route: RouteStep[] = [
      { tool: "debug", args: { program: "task.py" } },
      {
        tool: "read",
        args: { path: /^debug:[a-z0-9-]+\/source$/u, views: ["breakpoints"] },
        after: [0],
      },
    ];
    const launch: Call = { tool: "debug", args: { program: "task.py" }, text: "debug:session-1" };
    const read: Call = { tool: "read", args: { path: "task.py", views: ["breakpoints"] } };
    assert.ok(validateRoute({ steps: route }, events([launch, read], mode), mode).passed);
    for (const args of [
      { path: "other.py", views: ["breakpoints"] },
      { path: "task.py" },
      { path: "task.py", views: ["anchors"] },
    ])
      assert.equal(
        validateRoute({ steps: route }, events([launch, { ...read, args }], mode), mode).passed,
        false,
      );
    assert.equal(validateRoute({ steps: route }, events([read, launch], mode), mode).passed, false);
    assert.equal(validateRoute({ steps: route }, events([read], mode), mode).passed, false);
  });
  void test(`${mode}: Pi-coerced numeric arguments match without mutating evidence or structured results`, () => {
    const readStep: RouteStep = { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } };
    const route = [readStep];
    const retained = events(
      [{ tool: "read", args: { path: "/workspace/fixture/task.txt", offset: "2", limit: "1" } }],
      mode,
    );
    const original = structuredClone(retained);
    assert.ok(validateRoute({ steps: route }, retained, mode).passed);
    assert.deepEqual(retained, original);
    const catalogCalls: Call[] = [
      { tool: "read", args: { path: "docs:ide-settings", limit: "1000" }, text: "ui.codemode" },
      ...["docs:ide-settings", "docs:all"].map((path) => ({
        tool: "search",
        args: { path, query: "ui.codemode", caseSensitive: true, limit: "1000" },
        text: "docs:ide-settings:1",
      })),
    ];
    assert.ok(passes("ide-settings-catalog", catalogCalls, mode));
    assert.equal(
      passes(
        "ide-settings-catalog",
        catalogCalls.map((call) => ({ ...call, args: { ...call.args, limit: "999" } })),
        mode,
      ),
      false,
    );
    for (const offset of ["two", "2x", "3", "2.5", "0"]) {
      assert.equal(
        validateRoute(
          { steps: route },
          events([{ tool: "read", args: { path: "task.txt", offset, limit: "1" } }], mode),
          mode,
        ).passed,
        false,
      );
    }
    const strict: RouteStep[] = [{ tool: "read", scriptResult: { count: 2 } }];
    assert.equal(
      validateRoute(
        { steps: strict },
        events([{ tool: "read", args: { path: "task.txt" }, value: { count: "2" } }], mode),
        mode,
      ).passed,
      false,
    );
    const windowRoute: RouteStep[] = [
      readStep,
      {
        tool: "replace",
        args: { path: "task.txt", at: "OLD\n", text: "NEW\n" },
        reuse: { from: 0, field: ["path", "at"] },
      },
    ];
    assert.ok(
      validateRoute(
        { files: { "task.txt": "keep\nOLD\nlast\n" }, steps: windowRoute },
        events(
          [
            {
              tool: "read",
              args: { path: "task.txt", offset: "2", limit: "1" },
              value: { id: result },
            },
            { tool: "replace", args: { path: result, text: "NEW\n" } },
          ],
          mode,
        ),
        mode,
      ).passed,
    );
  });

  void test(`${mode}: read-jq explicit paths can overlap or execute in either order`, () => {
    const calls: [Call, Call] = [
      {
        tool: "read",
        args: { path: "config.json", views: ["jq:.status"] },
        text: `ready ${result}`,
      },
      {
        tool: "read",
        args: {
          path: "/workspace/fixture/config.json",
          views: ["jq:.status, .untouched"],
          offset: 2,
          limit: 1,
        },
        text: "7",
      },
    ];
    const sequential = events(calls, mode);
    const prefix = mode === "codemode" ? sequential.slice(0, 1) : [];
    const suffix = mode === "codemode" ? sequential.slice(-1) : [];
    const [start0, end0, start1, end1] = mode === "codemode" ? sequential.slice(1, -1) : sequential;
    assert.ok(start0 && end0 && start1 && end1);
    for (const middle of [
      [start0, start1, end0, end1],
      [start1, end1, start0, end0],
    ]) {
      assert.ok(validateRoute(task("read-jq"), [...prefix, ...middle, ...suffix], mode).passed);
      assert.equal(
        validateRoute(
          task("read-jq"),
          [...prefix, ...middle.filter((event) => event.toolCallId !== "0"), ...suffix],
          mode,
        ).passed,
        false,
      );
    }
    for (const path of ["other.json", "RESULT#22222222-aaaa-4aaa-8aaa-222222222222"]) {
      assert.equal(
        passes("read-jq", [calls[0], { ...calls[1], args: { ...calls[1].args, path } }], mode),
        false,
      );
    }
    const referenceStart = { ...start1, args: { ...start1.args, path: result } };
    assert.equal(
      validateRoute(
        task("read-jq"),
        [...prefix, start0, referenceStart, end0, end1, ...suffix],
        mode,
      ).passed,
      false,
    );
    assert.ok(
      validateRoute(
        task("read-jq"),
        [...prefix, start0, end0, referenceStart, end1, ...suffix],
        mode,
      ).passed,
    );
  });

  void test(`${mode}: explicit sources retain issuer slots and parent separation`, () => {
    const calls: Call[] = [{ tool: "read", args: { path: "config.json" } }];
    for (const from of [-1, 0, 1]) {
      assert.equal(
        validateRoute(
          {
            steps: [
              {
                tool: "read",
                reuse: { from, field: "path", explicit: "config.json" },
              },
            ],
          },
          events(calls, mode),
          mode,
        ).passed,
        false,
      );
    }
    if (mode === "codemode") {
      assert.equal(
        validateRoute(
          {
            steps: [
              { tool: "tool_search", discovers: ["read"] },
              { tool: "read", reuse: { from: 0, field: "path", explicit: "config.json" } },
            ],
          },
          events(calls, mode),
          mode,
        ).passed,
        false,
      );
      assert.equal(
        validateRoute(
          {
            steps: [
              { tool: "read" },
              {
                tool: "read",
                reuse: { from: 0, field: "path", explicit: "config.json", newParent: true },
              },
            ],
          },
          events([...calls, ...calls], mode),
          mode,
        ).passed,
        false,
      );
    }
  });
  for (const tool of ["insert", "replace", "delete", "copy", "move"]) {
    void test(`${mode}: fresh Search fragments remain provable after a prior edit for ${tool}`, () => {
      const fragment = "α\r\nβ";
      const match = "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
      const selector = tool === "insert" ? "anchor" : tool === "replace" ? "at" : "start";
      const extra =
        tool === "insert"
          ? { text: "]", before: false }
          : tool === "replace"
            ? { text: "NEW" }
            : ["copy", "move"].includes(tool)
              ? { target: "target.txt" }
              : {};
      const opening: Call = {
        tool: "insert",
        args: { path: "task.txt", anchor: "α", text: "[", before: true },
      };
      const found: Call = {
        tool: "search",
        args: { path: "task.txt", query: "regex:α\\r?\\nβ", multiline: true },
        text: "SEARCH#ABCD:1:match SEARCH#ABCD:1:line",
        value: {
          id: result,
          complete: true,
          matches: [
            {
              id: match,
              path: "task.txt",
              line: 2,
              text: fragment,
              lineText: "left [α\r\nβ right",
            },
          ],
        },
      };
      const closing: Call = {
        tool,
        args: { path: "task.txt", [selector]: { id: match }, ...extra },
      };
      const route: RouteStep[] = [
        { tool: "insert", args: opening.args },
        { tool: "search", args: found.args, after: [0] },
        {
          tool,
          args: { path: "task.txt", [selector]: fragment, ...extra },
          reuse: { from: 1, field: ["path", selector] },
          after: [1],
        },
      ];
      const files = { "task.txt": "head\r\nleft α\r\nβ right\r\n" };
      const check = (calls: Call[]) =>
        validateRoute({ files, steps: route }, events(calls, mode), mode).passed;
      for (const reference of [{ id: match }, { id: result }, "SEARCH#ABCD:1:match"]) {
        assert.ok(
          check([opening, found, { ...closing, args: { ...closing.args, [selector]: reference } }]),
        );
      }
      assert.ok(check([opening, found, { ...closing, args: { path: { id: match }, ...extra } }]));
      for (const args of [
        { ...closing.args, path: "other.txt" },
        { ...closing.args, [selector]: "RESULT#33333333-aaaa-4aaa-8aaa-333333333333" },
        { ...closing.args, [selector]: "SEARCH#ABCD:1:line" },
      ])
        assert.equal(check([opening, found, { ...closing, args }]), false);
      for (const selected of [
        { id: match, path: "other.txt", line: 2, text: fragment, lineText: "left [α\r\nβ right" },
        { id: match, path: "task.txt", line: 2, text: "β", lineText: "left [α\r\nβ right" },
      ]) {
        assert.equal(
          check([
            opening,
            { ...found, value: { id: result, complete: true, matches: [selected] } },
            closing,
          ]),
          false,
        );
      }
      // A literal selects only its characters, so a match that spans its whole lines still proves it.
      assert.ok(
        check([
          opening,
          {
            ...found,
            value: {
              id: result,
              complete: true,
              matches: [
                { id: match, path: "task.txt", line: 2, text: fragment, lineText: fragment },
              ],
            },
          },
          closing,
        ]),
      );
      const changed: Call = {
        tool: "insert",
        args: { path: "task.txt", anchor: "head", text: "!", before: true },
      };
      assert.equal(check([opening, found, changed, closing]), false);
      assert.ok(check([opening, found, { ...changed, error: true }, closing]));
      assert.ok(
        check([
          opening,
          found,
          { ...changed, args: { ...changed.args, path: "other.txt" } },
          closing,
        ]),
      );
      const ranged = (startColumn: number, endColumn: number): Call => ({
        ...found,
        value: {
          id: result,
          complete: true,
          matches: [
            {
              id: match,
              path: "task.txt",
              line: 2,
              text: fragment,
              lineText: "left [α\r\nβ right",
              range: { startLine: 2, startColumn, endLine: 3, endColumn },
            },
          ],
        },
      });
      assert.ok(check([opening, ranged(6, 1), closing]));
      assert.equal(check([opening, ranged(5, 1), closing]), false);
      assert.equal(check([opening, ranged(6, 2), closing]), false);
      const concurrent = events([opening, changed, found, closing], mode);
      const prefix = mode === "codemode" ? concurrent.slice(0, 1) : [];
      const suffix = mode === "codemode" ? concurrent.slice(-1) : [];
      const middle = mode === "codemode" ? concurrent.slice(1, -1) : concurrent;
      for (const order of [
        [0, 1, 2, 4, 5, 3, 6, 7],
        [0, 1, 4, 5, 2, 6, 7, 3],
      ]) {
        const reordered = order.map((index) => middle[index]);
        assert.ok(reordered.every((event): event is RunEvent => event !== undefined));
        assert.equal(
          validateRoute({ files, steps: route }, [...prefix, ...reordered, ...suffix], mode).passed,
          false,
        );
      }
      assert.equal(check([opening, { ...found, error: true }, closing]), false);
      assert.equal(check([opening, closing]), false);
      assert.equal(
        check([
          opening,
          {
            ...found,
            value: {
              id: result,
              complete: true,
              matches: [
                {
                  id: match,
                  path: "task.txt",
                  line: 2,
                  text: fragment,
                  lineText: "left [α\r\nβ right",
                },
                {
                  id: "other",
                  path: "task.txt",
                  line: 4,
                  text: fragment,
                  lineText: "left α\r\nβ right",
                },
              ],
            },
          },
          { ...closing, args: { path: { id: result }, ...extra } },
        ]),
        false,
      );
    });
  }
  for (const ending of ["lf", "crlf", "unterminated"]) {
    void test(`${mode}: exact-eof-${ending} requires literal block selection and omitted end without prescribing boundary spelling`, () => {
      const eol = ending === "crlf" ? "\r\n" : "\n";
      const calls: [Call, Call, Call, Call, Call] = [
        { tool: "replace", args: { path: "last.txt", at: "Last", text: "Final" } },
        { tool: "delete", args: { path: "block.txt", start: `${eol}Last${eol}Block` } },
        {
          tool: "replace",
          args: { path: "empty.txt", at: `${eol}Last${eol}Block`, text: "" },
        },
        { tool: "read", args: { path: "line.txt", views: ["anchors"] }, text: "ABCDEFG|Last" },
        { tool: "delete", args: { path: "line.txt", start: "ABCDEFG" } },
      ];
      const id = `exact-eof-${ending}`;
      assert.ok(passes(id, calls, mode));
      for (const start of [
        `${eol}${eol}Last${eol}Block`,
        `First${eol}Last${eol}Block`,
        `${eol}Last${eol}Block${eol}`,
      ]) {
        assert.equal(
          passes(
            id,
            [calls[0], { ...calls[1], args: { ...calls[1].args, at: start } }, ...calls.slice(2)],
            mode,
          ),
          true,
        );
      }
      for (const field of [
        { path: "wrong.txt" },
        { through: "Block" },
        { at: "regex:Last" },
        { at: "SEARCH#ABCD:1:match" },
      ]) {
        assert.equal(
          passes(
            id,
            [calls[0], { ...calls[1], args: { ...calls[1].args, ...field } }, ...calls.slice(2)],
            mode,
          ),
          false,
        );
      }
    });
  }

  void test(`${mode}: insert-before accepts equivalent fragment edges but retains side and issued-reference requirements`, () => {
    const calls: Call[] = [
      {
        tool: "insert",
        args: {
          path: "task.txt",
          anchor: "OLD",
          text: "NOTE",
          before: true,
          separation: "blank-line",
        },
      },
      { tool: "insert", args: { path: "literal.txt", anchor: "α🙂", text: "[", before: true } },
      { tool: "insert", args: { path: "literal.txt", anchor: "α🙂", text: "]" } },
      { tool: "insert", args: { path: "block.txt", anchor: "α", text: "[", before: true } },
      { tool: "insert", args: { path: "block.txt", anchor: "β", text: "]" } },
      { tool: "search", args: { path: "search.txt", query: "MATCH" }, text: "SEARCH#ABCD:1:match" },
      {
        tool: "insert",
        args: { path: "search.txt", anchor: "SEARCH#ABCD:1:match", text: "[", before: true },
      },
      { tool: "search", args: { path: "search.txt", query: "MATCH" }, text: "SEARCH#DCBA:1:match" },
      { tool: "insert", args: { path: "search.txt", anchor: "SEARCH#DCBA:1:match", text: "]" } },
    ];
    assert.ok(passes("insert-before", calls, mode));
    for (const [index, anchor] of [
      [3, "β"],
      [4, "α"],
    ] as const)
      assert.ok(
        passes(
          "insert-before",
          calls.map((call, position) =>
            position === index ? { ...call, args: { ...call.args, anchor } } : call,
          ),
          mode,
        ),
      );
    for (const [index, fields] of [
      [3, { anchor: "regex:α" }],
      [4, { anchor: "SEARCH#ABCD:1:match" }],
      [3, { before: false }],
      [4, { before: true }],
      [3, { path: "literal.txt" }],
      [6, { anchor: "SEARCH#FFFF:1:match" }],
      [8, { anchor: "SEARCH#ABCD:1:match" }],
      [6, { anchor: "MATCH" }],
    ] as const) {
      assert.equal(
        passes(
          "insert-before",
          calls.map((call, position) =>
            position === index ? { ...call, args: { ...call.args, ...fields } } : call,
          ),
          mode,
        ),
        false,
      );
    }
    assert.equal(
      passes(
        "insert-before",
        calls.filter((_, index) => index !== 7),
        mode,
      ),
      false,
    );
  });
}
