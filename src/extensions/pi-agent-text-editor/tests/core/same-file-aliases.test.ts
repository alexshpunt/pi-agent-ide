import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { ResultTargetStore } from "pi-agent-resource";
import { resolveExactTextAnchor } from "pi-agent-text-anchor-exact/api/anchor";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_SEARCH_ANCHOR_KIND,
} from "#src/api/plugin-protocol.ts";
import { createResultTargetAnchors } from "#src/core/result-target-anchors.ts";
import { findSourceAliases } from "#src/core/source-aliases.ts";
import { createTextEditorCore } from "#src/core/text-editor-core.ts";
import { createTextTool } from "#src/core/text-mutation.ts";
import { ToolCallInterceptionRenderStore } from "#src/core/tool-call-interceptor/rendering.ts";
import { copyMutationTool } from "#src/tools/tool-text-copy.ts";
import { moveMutationTool } from "#src/tools/tool-text-move.ts";

const content = "alpha beta gamma\n";
let cwd: string;

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "same-file-aliases-")));
  await writeFile(path.join(cwd, "main.txt"), content);
  await writeFile(path.join(cwd, "other.txt"), content);
  await symlink("main.txt", path.join(cwd, "link.txt"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** A filesystem-like resolver that keeps the requested name, as the real one does. */
async function editor(tool: typeof moveMutationTool | typeof copyMutationTool) {
  const store = new ResultTargetStore();
  const core = createTextEditorCore();
  core.addMutationTool(tool);
  await core.registerPlugin({
    id: "alias-test",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addAnchorResolver(createResultTargetAnchors(store));
      api.addAnchorResolver({
        kind: TEXT_SEARCH_ANCHOR_KIND,
        type: "auxiliary",
        resolver: {
          id: "exact",
          description: "Exact text",
          renderFull: (value) => value,
          renderCompact: (value) => value,
          tryResolve: (value, document) => Promise.resolve(resolveExactTextAnchor(value, document)),
        },
      });
      api.addResolver({
        resolver: {
          id: "files",
          async tryResolve(requested) {
            const file = path.resolve(cwd, requested);
            return {
              kind: "resolved",
              resource: {
                source: requested,
                async read() {
                  return [{ type: "text", text: await readFile(file, "utf8") }];
                },
                async write(blocks) {
                  const block = blocks[0];
                  if (blocks.length !== 1 || block.type !== "text") throw Error("Expected text");
                  await writeFile(file, block.text);
                },
              },
            };
          },
        },
      });
    },
  });
  const run = createTextTool(
    core,
    tool,
    new ToolCallInterceptionRenderStore(),
    () => undefined,
    store,
  );
  return {
    /** A Search result selecting `alpha ` in the named file. */
    search(file: string) {
      return store.register(
        [
          {
            source: file,
            expectedContent: content,
            readCurrent: () => readFile(path.resolve(cwd, file), "utf8"),
            ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 6 } }],
          },
        ],
        cwd,
      );
    },
    execute: (parameters: Record<string, unknown>) =>
      run.execute("call", parameters, undefined, undefined, {
        cwd,
      } as ExtensionToolContext),
  };
}

const absolute = (name: string) => path.join(cwd, name);
type Naming = "absolute" | "relative" | "symlink";
/** Name main.txt the given way; the working directory exists only while a test runs. */
const named = (naming: Naming) =>
  naming === "absolute" ? absolute("main.txt") : naming === "relative" ? "main.txt" : "link.txt";

describe.each([
  ["move", moveMutationTool, "beta gammaalpha \n"],
  ["copy", copyMutationTool, "alpha beta gammaalpha \n"],
] as const)("%s within one file named differently", (_name, tool, expected) => {
  test.each([
    ["an absolute result and a relative target", "absolute", "relative"],
    ["a relative result and an absolute target", "relative", "absolute"],
    ["an absolute result and a symlink target", "absolute", "symlink"],
    ["a symlink result and an absolute target", "symlink", "absolute"],
  ] as const)("succeeds for %s", async (_label, sourceNaming, targetNaming) => {
    const run = await editor(tool);
    const result = await run.execute({
      path: run.search(named(sourceNaming)),
      target: named(targetNaming),
      targetStart: "gamma",
    });

    expect(result.details.effect).not.toBe("not-applied");
    expect(result.details.results?.every((item) => item.data.ok)).toBe(true);
    expect(await readFile(absolute("main.txt"), "utf8")).toBe(expected);
  });

  test.each([
    ["a relative source and an absolute target", "relative", "absolute"],
    ["an absolute source and a relative target", "absolute", "relative"],
    ["a symlink source and a relative target", "symlink", "relative"],
  ] as const)("succeeds for literal paths with %s", async (_label, sourceNaming, targetNaming) => {
    const run = await editor(tool);
    const result = await run.execute({
      path: named(sourceNaming),
      start: "alpha ",
      target: named(targetNaming),
      targetStart: "gamma",
    });

    expect(result.details.effect).not.toBe("not-applied");
    expect(await readFile(absolute("main.txt"), "utf8")).toBe(expected);
  });
});

test("a move between two different files still edits two files", async () => {
  const run = await editor(moveMutationTool);
  const result = await run.execute({
    path: run.search(absolute("main.txt")),
    target: "other.txt",
    targetStart: "gamma",
  });

  expect(result.details.effect).not.toBe("not-applied");
  expect(await readFile(absolute("main.txt"), "utf8")).toBe("beta gamma\n");
  expect(await readFile(absolute("other.txt"), "utf8")).toBe("alpha beta gammaalpha \n");
});

describe("findSourceAliases", () => {
  test("names every alias of one file by its first name", async () => {
    const aliases = await findSourceAliases(
      [absolute("main.txt"), "main.txt", "link.txt", "./main.txt"],
      cwd,
    );

    expect(Object.fromEntries(aliases)).toEqual({
      "main.txt": absolute("main.txt"),
      "link.txt": absolute("main.txt"),
      "./main.txt": absolute("main.txt"),
    });
  });

  test("keeps different files and unknown protocols apart", async () => {
    const aliases = await findSourceAliases(
      ["main.txt", "other.txt", "ssh://host/main.txt", "fixture://main.txt"],
      cwd,
    );

    expect(aliases.size).toBe(0);
  });
});
