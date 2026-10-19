import { ResultTargetStore } from "pi-agent-resource";
import { expect, test } from "vitest";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_SEARCH_ANCHOR_KIND,
} from "#src/api/plugin-protocol.js";

async function fixture() {
  const cwd = "/fixture";
  const source = "/fixture/note.txt";
  let content = "OLD\n";
  const reads: string[] = [];
  const store = new ResultTargetStore();
  const core = createTextEditorCore(undefined, store);
  const ranges = [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 3 } }];
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "inspection-source",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "inspection-source",
          async tryResolve(value) {
            reads.push(value);
            if (value !== source) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  return [{ type: "text", text: content }];
                },
              },
            };
          },
        },
      });
      api.addAnchorResolver({
        kind: TEXT_SEARCH_ANCHOR_KIND,
        type: "auxiliary",
        resolver: {
          id: "inspection-anchor",
          description: "Test anchor.",
          renderFull: (value) => value,
          renderCompact: (value) => value,
          async tryResolve(value, context) {
            if (value !== "OLD") return { kind: "not-handled" };
            return {
              kind: "resolved",
              anchor: new TextSelectionAnchor(value, context.source, ranges),
            };
          },
        },
      });
    },
  });
  const issue = (owner = cwd, complete = true) => {
    const target = store.register(
      [{ source, expectedContent: content, ranges, readCurrent: async () => content }],
      owner,
      complete,
    );
    const shown = store.publish({ status: "success", data: { target } }, "Selection", owner);
    const id = /<uuid>([^<]+)<\/uuid>/u.exec(shown)?.[1];
    if (!id) throw new Error("Missing issued ID");
    return id;
  };
  return {
    core,
    cwd,
    source,
    reads,
    issue,
    change: () => {
      content = "CHANGED\n";
    },
  };
}

const request = (source: string, cwd: string) => ({
  source,
  cwd,
  anchors: ["OLD"] as const,
  kinds: [[TEXT_SEARCH_ANCHOR_KIND]] as const,
});

test("anchor inspection resolves a current issued UUID through its actual source", async () => {
  const run = await fixture();
  expect(await run.core.inspectTextAnchors(request(run.issue(), run.cwd))).toEqual({
    kind: "valid",
  });
  expect(run.reads).toEqual([run.source]);
});

test.each(["stale", "foreign", "invented", "incomplete"] as const)(
  "anchor inspection rejects a %s result before resource resolution",
  async (kind) => {
    const run = await fixture();
    const reference =
      kind === "invented"
        ? "11111111-1111-4111-8111-111111111111"
        : run.issue(kind === "foreign" ? "/other-worktree" : run.cwd, kind !== "incomplete");
    if (kind === "stale") run.change();
    expect((await run.core.inspectTextAnchors(request(reference, run.cwd))).kind).toBe("failed");
    expect(run.reads).toEqual([]);
  },
);
