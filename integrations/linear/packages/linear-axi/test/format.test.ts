import test from "node:test";
import assert from "node:assert/strict";
import { renderToon } from "#axi/format.ts";
import { compactIssues } from "#axi/lib/linear-format.ts";

void test("renders tabular arrays with counts", () => {
  assert.equal(
    renderToon({
      issues: [
        { id: "LIN-1", title: "Fix auth", state: "Todo" },
        { id: "LIN-2", title: "Ship, docs", state: "Done" },
      ],
    }),
    'issues[2]{id,title,state}:\n  LIN-1,Fix auth,Todo\n  LIN-2,"Ship, docs",Done\n',
  );
});

void test("quotes ambiguous scalar values", () => {
  assert.equal(
    renderToon({ value: "true", empty: "", text: "hello" }),
    'value: "true"\nempty: ""\ntext: hello\n',
  );
});

void test("renders empty arrays compactly", () => {
  assert.equal(renderToon({ issues: [] }), "issues: []\n");
});

void test("renders help arrays as multiline hints", () => {
  assert.equal(
    renderToon({ help: ["Run `linear-axi issues list`", "Run `linear-axi auth login`"] }),
    "help[2]:\n  Run `linear-axi issues list`\n  Run `linear-axi auth login`\n",
  );
});

void test("compact issue sorting preserves input order within the same status", () => {
  assert.deepEqual(
    compactIssues([
      { identifier: "LIN-2", title: "Second", state: "Todo" },
      { identifier: "LIN-1", title: "First", state: "Todo" },
    ]).map((issue) => issue.id),
    ["LIN-2", "LIN-1"],
  );
});
