import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type CapabilityCase, type RouteStep, type RunEvent } from "./validation.ts";

interface Call {
  tool: string;
  args: Record<string, unknown>;
  text?: string;
  value?: unknown;
  error?: boolean;
}
const id = "RESULT#11111111-aaaa-4aaa-8aaa-111111111111";
const matchId = "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
function events(calls: Call[], mode: string): RunEvent[] {
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
function passed(files: Record<string, string>, steps: RouteStep[], calls: Call[], mode: string) {
  return validateRoute({ files, steps }, events(calls, mode), mode).passed;
}
function search(path: string, text: string, lineText = text, line = 1): Call {
  return {
    tool: "search",
    args: { path, query: text },
    text: "SEARCH#ABCD:all:match SEARCH#ABCD:1:match SEARCH#ABCD:1:line",
    value: { id, complete: true, matches: [{ id: matchId, path, line, text, lineText }] },
  };
}
function multiRead(): Call {
  return {
    tool: "read",
    args: { path: ["source.txt", "target.txt"], views: ["anchors"] },
    text: "--- source.txt ---\n123ABCD|Last\n--- target.txt ---\n765ABCD|Top\n",
    value: [
      { id, text: "123ABCD|Last" },
      { id: matchId, text: "765ABCD|Top\n" },
    ],
  };
}
for (const mode of ["direct", "codemode"]) {
  void test(`a Search result path supplies an implicit issued at selector in ${mode}`, () => {
    const files = { "source.txt": "head\nmove-me\nend\n", "target.txt": "Top\n" };
    const route: RouteStep[] = [
      { tool: "search" },
      {
        tool: "move",
        error: "direct",
        args: {
          path: "source.txt",
          at: /move-me|[A-Z]+#/u,
          target: "target.txt",
          targetAfter: "Top",
        },
        reuse: { from: 0, field: ["path", "at"] },
      },
    ];
    const found = search("source.txt", "move-me", "move-me", 2);
    const move: Call = {
      tool: "move",
      error: true,
      args: { path: found.value, target: "target.txt", targetAfter: "Top" },
    };
    assert.ok(passed(files, route, [found, move], mode));
    const target: Call = {
      ...search("target.txt", "Top"),
      value: {
        id: "RESULT#33333333-aaaa-4aaa-8aaa-333333333333",
        complete: true,
        matches: [
          {
            id: "RESULT#44444444-aaaa-4aaa-8aaa-444444444444",
            path: "target.txt",
            line: 1,
            text: "Top",
            lineText: "Top",
          },
        ],
      },
    };
    const targetRoute: RouteStep[] = [
      { tool: "search" },
      { tool: "search" },
      {
        tool: "move",
        error: "direct",
        args: {
          path: "source.txt",
          at: /move-me|[A-Z]+#/u,
          target: "target.txt",
          targetAt: /Top|[A-Z]+#/u,
        },
        reuse: [
          { from: 0, field: "path" },
          { from: 1, field: "target" },
        ],
      },
    ];
    assert.ok(
      passed(
        files,
        targetRoute,
        [found, target, { ...move, args: { path: found.value, target: target.value } }],
        mode,
      ),
    );
    assert.ok(
      !passed(
        files,
        targetRoute,
        [found, target, { ...move, args: { path: found.value, target: found.value } }],
        mode,
      ),
    );
    for (const args of [
      { ...move.args, at: "Wrong" },
      { ...move.args, path: { id: "RESULT#55555555-aaaa-4aaa-8aaa-555555555555" } },
      { ...move.args, target: "wrong.txt" },
    ])
      assert.ok(!passed(files, route, [found, { ...move, args }], mode));
    assert.ok(!passed(files, route, [{ ...found, error: true }, move], mode));
    assert.ok(
      !passed(
        files,
        route,
        [
          {
            ...found,
            args: { path: "wrong.txt", query: "move-me" },
            value: {
              id,
              complete: true,
              matches: [
                { id: matchId, path: "wrong.txt", line: 2, text: "move-me", lineText: "move-me" },
              ],
            },
          },
          move,
        ],
        mode,
      ),
    );
    assert.ok(!passed(files, route, [move], mode));
  });
  void test(`multi-Read element references identify source and destination in ${mode}`, () => {
    const files = { "source.txt": "Last", "target.txt": "Top\n" };
    const route: RouteStep[] = [
      { tool: "read" },
      {
        tool: "move",
        // A literal Top would select only its characters, not the line the anchor selects.
        args: {
          path: "source.txt",
          at: "Last",
          target: "target.txt",
          targetAfter: /^765ABCD$/u,
        },
      },
    ];
    const move: Call = {
      tool: "move",
      args: {
        path: { id },
        at: "123ABCD|Last\n",
        target: { id: matchId },
        targetAfter: "765ABCD|Top\n",
      },
    };
    assert.ok(passed(files, route, [multiRead(), move], mode));
    const unissued = "RESULT#55555555-aaaa-4aaa-8aaa-555555555555";
    const quoted = multiRead();
    quoted.value = [
      { id, text: `123ABCD|Last\n111ABCD|${unissued}\n` },
      { id: matchId, text: "765ABCD|Top\n" },
    ];
    assert.ok(
      !passed(
        { ...files, "source.txt": `Last\n${unissued}\n` },
        route,
        [quoted, { ...move, args: { ...move.args, path: { id: unissued } } }],
        mode,
      ),
    );
    for (const change of [
      { path: { id: matchId } },
      { target: { id } },
      { at: "765ABCD|Top\n" },
      { targetAfter: "123ABCD|Last\n" },
      { at: "123ABCD|Wrong\n" },
    ])
      assert.ok(
        !passed(files, route, [multiRead(), { ...move, args: { ...move.args, ...change } }], mode),
        JSON.stringify(change),
      );
    for (const value of [
      { id },
      [{ id, text: "123ABCD|Last" }],
      [
        { id, text: "123ABCD|Last" },
        { id, text: "765ABCD|Top\n" },
      ],
    ])
      assert.ok(!passed(files, route, [{ ...multiRead(), value }, move], mode));
    assert.ok(!passed(files, route, [{ ...multiRead(), error: true }, move], mode));
    assert.ok(!passed(files, route, [move, multiRead()], mode));
  });
  void test(`multi-Read anchors prove exact unterminated lines without borrowing sibling text in ${mode}`, () => {
    const files = { "source.txt": "First\nLast", "target.txt": "First\nLast" };
    const read = multiRead();
    read.text =
      "--- source.txt ---\n111ABCD|First\n123ABCD|Last\n--- target.txt ---\n111ABCD|First\n765ABCD|Last";
    read.value = [
      { id, text: "111ABCD|First\n123ABCD|Last" },
      { id: matchId, text: "111ABCD|First\n765ABCD|Last" },
    ];
    const route: RouteStep[] = [
      { tool: "read" },
      {
        tool: "replace",
        args: { path: "source.txt", at: "Last", text: "Final" },
        reuse: { from: 0, field: "at", kind: "anchor" },
      },
    ];
    const replace: Call = {
      tool: "replace",
      args: { path: { id }, at: "123ABCD", text: "Final" },
    };
    for (const start of ["123ABCD", "123ABCD|Last", "123ABCD|Last\n"])
      assert.ok(
        passed(files, route, [read, { ...replace, args: { ...replace.args, at: start } }], mode),
      );
    const single = { ...read, args: { ...read.args, path: ["source.txt"] }, value: { id } };
    assert.ok(passed(files, route, [single, replace], mode));
    for (const args of [
      { path: { id }, text: "Final" },
      { path: "source.txt", at: { id }, text: "Final" },
    ])
      assert.ok(!passed(files, route, [read, { tool: "replace", args }], mode));
    // Literal paths must also restrict evidence to the selected array element.
    assert.ok(
      !passed(
        files,
        route,
        [read, { ...replace, args: { ...replace.args, path: "source.txt", at: "765ABCD" } }],
        mode,
      ),
    );
    assert.ok(
      !passed(files, route, [read, { ...replace, args: { ...replace.args, text: "Wrong" } }], mode),
    );
    assert.ok(
      !passed(
        files,
        route,
        [read, { tool: "replace", args: { path: "source.txt", at: "Last", text: "Final" } }],
        mode,
      ),
    );
    const mutation: Call = {
      tool: "replace",
      args: { path: { id }, at: "Last", text: "Changed" },
    };
    assert.ok(!passed(files, route, [read, mutation, replace], mode));
    // Null siblings retain their slot and must not shift a later result onto the wrong path.
    const partial = { ...read, value: [null, { id: matchId, text: "765ABCD|Last" }] };
    const targetRoute: RouteStep[] = [
      { tool: "read" },
      { tool: "replace", args: { path: "target.txt", at: "Last", text: "Final" } },
    ];
    const targetEdit: Call = {
      tool: "replace",
      args: { path: { id: matchId }, at: "765ABCD", text: "Final" },
    };
    assert.ok(passed(files, targetRoute, [partial, targetEdit], mode));
    assert.ok(!passed(files, route, [partial, replace], mode));
  });
  void test(`displayed anchors keep issued provenance and one optional separator in ${mode}`, () => {
    const route: RouteStep[] = [
      { tool: "read" },
      {
        tool: "replace",
        args: { path: "task.txt", at: /^[0-9A-HJKMNP-TV-Z]{7}$/u, text: "NEW" },
        reuse: { from: 0, field: "at", kind: "anchor" },
      },
    ];
    const read: Call = {
      tool: "read",
      args: { path: "task.txt", views: ["anchors"] },
      text: "123ABCD|OLD\r\n",
      value: { id },
    };
    for (const anchor of ["123ABCD", "123ABCD|OLD", "123ABCD|OLD\r\n", "123ABCD|OLD\n"]) {
      const edit: Call = {
        tool: "replace",
        args: { path: "task.txt", at: anchor, text: "NEW" },
      };
      assert.ok(passed({ "task.txt": "OLD\r\n" }, route, [read, edit], mode), anchor);
      assert.ok(!passed({ "task.txt": "OLD\r\n" }, route, [{ ...read, error: true }, edit], mode));
    }
    for (const anchor of ["123ABCD|OTHER", "123ABCD|OLD\n\n", "765ABCD|OLD"]) {
      assert.ok(
        !passed(
          { "task.txt": "OLD\r\n" },
          route,
          [read, { tool: "replace", args: { path: "task.txt", at: anchor, text: "NEW" } }],
          mode,
        ),
      );
    }
  });
  void test(`file plus issued selector stands for a selector path, not another file, in ${mode}`, () => {
    const route: RouteStep[] = [
      { tool: "search" },
      {
        tool: "insert",
        args: { path: /^SEARCH#[A-F0-9]+:1:line$/u, text: "ADDED" },
        reuse: { from: 0, field: "path" },
      },
    ];
    for (const field of ["after"]) {
      const insert: Call = {
        tool: "insert",
        args: { path: "task.txt", [field]: "SEARCH#ABCD:1:line", text: "ADDED" },
      };
      assert.ok(passed({ "task.txt": "OLD\n" }, route, [search("task.txt", "OLD"), insert], mode));
      for (const change of [
        { path: "other.txt" },
        { [field]: "SEARCH#FFFF:1:line" },
        { [field]: "SEARCH#ABCD:1:match" },
      ])
        assert.ok(
          !passed(
            { "task.txt": "OLD\n" },
            route,
            [search("task.txt", "OLD"), { ...insert, args: { ...insert.args, ...change } }],
            mode,
          ),
        );
      assert.ok(
        !passed(
          { "task.txt": "OLD\n" },
          route,
          [{ ...search("task.txt", "OLD"), error: true }, insert],
          mode,
        ),
      );
    }
  });
  void test(`Copy exact endpoints and whole lines accept only equal issued spans in ${mode}`, () => {
    const files = {
      "source.txt": "prefix BEGIN body END suffix\n",
      "whole.txt": "before\r\n段🙂\r\nafter\r\n",
      "target.txt": "ANCHOR\nAFTER\n",
    };
    const calls: Call[] = [
      search("source.txt", "BEGIN", files["source.txt"].trim()),
      {
        ...search("source.txt", "END", files["source.txt"].trim()),
        text: "SEARCH#EF01:1:match",
        value: {
          id: "RESULT#33333333-aaaa-4aaa-8aaa-333333333333",
          complete: true,
          matches: [
            {
              path: "source.txt",
              line: 1,
              text: "END",
              lineText: files["source.txt"].trim(),
              id: "RESULT#44444444-aaaa-4aaa-8aaa-444444444444",
            },
          ],
        },
      },
      {
        tool: "copy",
        args: {
          path: "source.txt",
          from: "SEARCH#ABCD:1:match",
          through: "SEARCH#EF01:1:match",
          target: "target.txt",
        },
      },
    ];
    const route: RouteStep[] = [
      { tool: "search" },
      { tool: "search" },
      {
        tool: "copy",
        args: { path: "source.txt", from: "BEGIN", through: "END", target: "target.txt" },
      },
    ];
    assert.ok(passed(files, route, calls, mode));
    const copy = calls[2];
    assert.ok(copy);
    for (const change of [
      { from: "SEARCH#ABCD:1:line" },
      { from: "SEARCH#FFFF:1:match" },
      { path: "whole.txt" },
      { through: "SEARCH#ABCD:1:match" },
    ])
      assert.ok(
        !passed(
          files,
          route,
          [...calls.slice(0, 2), { ...copy, args: { ...copy.args, ...change } }],
          mode,
        ),
      );
    const read: Call = {
      tool: "read",
      args: { path: "whole.txt", views: ["anchors"] },
      text: "123ABCD|段🙂\r\n",
      value: { id },
    };
    const target: Call = {
      tool: "read",
      args: { path: "target.txt", views: ["anchors"] },
      text: "765ABCD|ANCHOR\n",
    };
    const lineRoute: RouteStep[] = [
      { tool: "read" },
      { tool: "read" },
      {
        tool: "copy",
        // Literals equal to issued line selections include the line breaks those select.
        args: {
          path: "whole.txt",
          at: "段🙂\r\n",
          target: "target.txt",
          targetAfter: "ANCHOR\n",
        },
      },
    ];
    for (const selector of ["123ABCD|段🙂\r\n", "SEARCH#ABCD:1:line"]) {
      const issuer = selector.startsWith("SEARCH") ? search("whole.txt", "段🙂", "段🙂", 2) : read;
      const currentRoute = [{ tool: issuer.tool }, ...lineRoute.slice(1)];
      assert.ok(
        passed(
          files,
          currentRoute,
          [
            issuer,
            target,
            {
              tool: "copy",
              args: {
                path: "whole.txt",
                at: selector,
                target: "target.txt",
                targetAfter: "765ABCD|ANCHOR\n",
              },
            },
          ],
          mode,
        ),
      );
    }
  });
  void test(`a one-line Read result can select exactly the final line in ${mode}`, () => {
    const route: RouteStep[] = [
      { tool: "read", args: { path: "line.txt", views: ["anchors"] } },
      {
        tool: "delete",
        args: { path: "line.txt", at: "Last\r\n" },
        reuse: { from: 0, field: ["path", "at"], kind: "anchor" },
      },
    ];
    const read: Call = {
      tool: "read",
      args: { path: "line.txt", offset: 2, limit: 1, views: ["anchors"] },
      text: "123ABCD|Last\r\n",
      value: { id },
    };
    const remove: Call = { tool: "delete", args: { path: { id } } };
    assert.ok(passed({ "line.txt": "First\r\nLast\r\n" }, route, [read, remove], mode));
    for (const change of [
      { offset: 1 },
      { offset: 1, limit: 2 },
      { path: "wrong.txt" },
      { views: ["anchors", "ast"] },
    ])
      assert.ok(
        !passed(
          { "line.txt": "First\r\nLast\r\n" },
          route,
          [{ ...read, args: { ...read.args, ...change } }, remove],
          mode,
        ),
      );
    assert.ok(
      !passed(
        { "line.txt": "First\r\nLast\r\n" },
        route,
        [read, { ...remove, args: { path: { id: matchId } } }],
        mode,
      ),
    );
  });
  void test(`multi-source results cannot borrow another file's identical text in ${mode}`, () => {
    const files = { "task.txt": "OLD\n", "other.txt": "OLD\n" };
    const route: RouteStep[] = [
      { tool: "search" },
      { tool: "copy", args: { path: "task.txt", at: "OLD", target: "target.txt" } },
    ];
    const found = search("other.txt", "OLD");
    found.args.path = ["task.txt", "other.txt"];
    const copy: Call = {
      tool: "copy",
      args: { path: "task.txt", at: "SEARCH#ABCD:1:line", target: "target.txt" },
    };
    assert.ok(!passed(files, route, [found, copy], mode));
    const insertRoute: RouteStep[] = [
      { tool: "search" },
      {
        tool: "insert",
        args: { path: /^SEARCH#[A-F0-9]+:1:line$/u, text: "NEW" },
        reuse: { from: 0, field: "path" },
      },
    ];
    const insert: Call = {
      tool: "insert",
      args: { path: "task.txt", after: "SEARCH#ABCD:1:line", text: "NEW" },
    };
    assert.ok(!passed(files, insertRoute, [found, insert], mode));
    const read: Call = {
      tool: "read",
      args: { path: ["task.txt", "other.txt"], views: ["anchors"] },
      text: "123ABCD|OLD\n",
      value: { id },
    };
    assert.ok(
      !passed(
        files,
        [{ tool: "read" }, route[1] as RouteStep],
        [read, { ...copy, args: { ...copy.args, at: "123ABCD|OLD\n" } }],
        mode,
      ),
    );
  });
  void test(`selection evidence cannot outlive a mutation or replace a required issuer in ${mode}`, () => {
    const files = { "task.txt": "OLD\nLast\n" };
    const route: RouteStep[] = [
      { tool: "read" },
      {
        tool: "copy",
        args: { path: "task.txt", at: "Last\n", target: "target.txt" },
        reuse: { from: 0, field: "at", kind: "anchor" },
      },
    ];
    const read: Call = {
      tool: "read",
      args: { path: "task.txt", views: ["anchors"] },
      text: "123ABCD|Last\n",
      value: { id },
    };
    const copy: Call = {
      tool: "copy",
      args: { path: "task.txt", at: "123ABCD|Last\n", target: "target.txt" },
    };
    assert.ok(passed(files, route, [read, copy], mode));
    assert.ok(!passed(files, route, [copy], mode));
    const edit: Call = {
      tool: "replace",
      args: { path: "task.txt", at: "Last", text: "Changed" },
    };
    assert.ok(!passed(files, route, [read, edit, copy], mode));
    assert.ok(
      !passed(
        files,
        route,
        [{ ...read, args: { path: "wrong.txt", views: ["anchors"] } }, copy],
        mode,
      ),
    );
    // Copy is read-only on its source: a second destination does not stale that evidence.
    const first: Call = { tool: "copy", args: { ...copy.args, target: "first.txt" } };
    assert.ok(passed(files, route, [read, first, copy], mode));
  });
  void test(`whole-result reuse accepts a complete single match but not part of a larger Search in ${mode}`, () => {
    const route: RouteStep[] = [
      { tool: "search" },
      {
        tool: "replace",
        args: { text: "NEW" },
        reuse: { from: 0, field: ["path", "at"], kind: "whole-result" },
      },
    ];
    const found = search("task.txt", "OLD");
    const replace: Call = {
      tool: "replace",
      args: { path: "task.txt", at: "SEARCH#ABCD:1:match", text: "NEW" },
    };
    assert.ok(passed({ "task.txt": "OLD\n" }, route, [found, replace], mode));
    for (const value of [
      { id, complete: false, matches: [{ id: matchId }] },
      { id, complete: true, matches: [{ id: matchId }, { id: "other" }] },
    ])
      assert.ok(!passed({ "task.txt": "OLD\n" }, route, [{ ...found, value }, replace], mode));
  });
  void test(`debug source Read accepts the launched program's path only in ${mode}`, () => {
    const route: RouteStep[] = [
      { tool: "debug", args: { program: "task.py" } },
      {
        tool: "read",
        args: { path: /^debug:[a-z0-9-]+\/source$/u, views: ["anchors"] },
        after: [0],
      },
    ];
    const launch: Call = { tool: "debug", args: { program: "task.py" }, text: "debug:session-1" };
    const read: Call = { tool: "read", args: { path: "task.py", views: ["anchors"] } };
    assert.ok(passed({ "task.py": "print(1)\n" }, route, [launch, read], mode));
    assert.ok(
      !passed(
        { "task.py": "print(1)\n" },
        route,
        [launch, { ...read, args: { ...read.args, path: "other.py" } }],
        mode,
      ),
    );
    assert.ok(
      !passed({ "task.py": "print(1)\n" }, route, [{ ...launch, error: true }, read], mode),
    );
  });
  void test(`stale recovery's fresh Read and rejected old Read are independent in ${mode}`, () => {
    const task = capabilityCases.find((entry) => entry.id === "stale-recovery") as CapabilityCase;
    const read: Call = {
      tool: "read",
      args: { path: "task.txt", views: ["anchors"] },
      text: "123ABCD|OLD\n",
      value: { id },
    };
    const edit: Call = {
      tool: "replace",
      args: { path: "task.txt", at: "OLD", text: "NEW" },
    };
    const old: Call = { tool: "read", args: { path: { id } }, error: true };
    const fresh: Call = { tool: "read", args: { path: "task.txt" }, text: "NEW" };
    assert.ok(validateRoute(task, events([read, edit, fresh, old], mode), mode).passed);
    assert.ok(!validateRoute(task, events([read, fresh, edit, old], mode), mode).passed);
  });
}

for (const mode of ["direct", "codemode"]) {
  void test(`name-capture reuse rejects declaration and unrelated capture IDs in ${mode}`, () => {
    const nameId = "RESULT#33333333-aaaa-4aaa-8aaa-333333333333";
    const otherId = "RESULT#44444444-aaaa-4aaa-8aaa-444444444444";
    const route: RouteStep[] = [
      { tool: "lsp_search" },
      {
        tool: "replace",
        args: { text: "total" },
        reuse: { from: 0, field: "path", kind: "capture:name" },
      },
    ];
    const declaration: Call = {
      tool: "lsp_search",
      args: { declaration: "task.ts#count" },
      text: `SEARCH#ABCD:1:match task.ts:1-1 declaration task.ts#count\ncapture name: ${nameId}\ncapture other: ${otherId}`,
      value: {
        id,
        complete: true,
        matches: [
          {
            id: matchId,
            path: "task.ts",
            line: 1,
            text: "export const count = 1;",
            captures: {
              name: [{ id: nameId, text: "count" }],
              other: [{ id: otherId, text: "1" }],
            },
          },
        ],
      },
    };
    const forms = (id: string) => [
      id,
      id.slice("RESULT#".length),
      { id },
      { id: id.slice("RESULT#".length) },
    ];
    for (const issuer of [
      declaration,
      { ...declaration, value: undefined },
      {
        ...declaration,
        value: undefined,
        text: declaration.text
          ?.split("\n")
          .map((line) => (line.startsWith("capture ") ? `   ${line}` : line))
          .join("\n"),
      },
      { ...declaration, text: "" },
    ]) {
      for (const reference of forms(nameId)) {
        const edit = { tool: "replace", args: { path: reference, text: "total" } };
        assert.ok(passed({}, route, [issuer, edit], mode));
        assert.ok(!passed({}, route, [{ ...issuer, error: true }, edit], mode));
        assert.ok(!passed({}, route, [edit, issuer], mode));
      }
      for (const reference of [
        ...[id, matchId, otherId, "RESULT#55555555-aaaa-4aaa-8aaa-555555555555"].flatMap(forms),
        "SEARCH#ABCD:1:match",
      ])
        assert.ok(
          !passed(
            {},
            route,
            [issuer, { tool: "replace", args: { path: reference, text: "total" } }],
            mode,
          ),
        );
    }
  });
}
