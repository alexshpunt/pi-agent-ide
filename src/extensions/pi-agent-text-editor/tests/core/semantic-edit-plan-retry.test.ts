import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ResourceError } from "pi-agent-resource";
import { expect, test } from "vitest";
import type { TextEditPlan } from "#src/api/edit-pipeline.ts";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.ts";
import { createTextEditorCore } from "#src/core/text-editor-core.ts";
import { executeTextMutation } from "#src/core/text-mutation.ts";
import { replaceMutationTool } from "#src/tools/tool-text-replace.ts";

const source = "fixture://renamed.txt";

/**
 * Where another process writes the file once: after the first plan and before the edit reads the
 * file, or after the edit read it and before it writes.
 */
type Window = "before-read" | "before-write";

/**
 * A rename planned like a language server rename: every `beta` of the current text becomes
 * `delta`, and a text without `beta` has no symbol to rename. Another process applies `write` to
 * the file once, in `window`. Like the filesystem resolver, a write refuses to replace text it
 * has not read.
 */
async function renameWithWindowWrite(
  window: Window,
  write: (text: string) => string,
  plan: (text: string, attempt: number) => TextEditPlan = renameBeta,
) {
  const file = { text: "alpha beta\nbeta gamma\n", writes: 0, plans: 0 };
  let pending = true;
  const writeOnce = (expected: Window) => {
    if (!pending || window !== expected) return;
    pending = false;
    file.text = write(file.text);
  };
  const core = createTextEditorCore();
  await core.registerPlugin({
    id: "fixture",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addResolver({
        resolver: {
          id: "fixture",
          async tryResolve(requested) {
            if (requested !== source) return { kind: "not-handled" };
            let readText: string | undefined;
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  readText = file.text;
                  return [{ type: "text", text: file.text }];
                },
                async write(content) {
                  writeOnce("before-write");
                  if (readText !== file.text)
                    throw new ResourceError("RESOURCE_CHANGED", source, "not-applied");
                  file.writes += 1;
                  file.text = content[0].type === "text" ? content[0].text : "";
                  readText = file.text;
                },
              },
            };
          },
        },
      });
      api.tool("replace").addHandler({
        stage: "text-pre-edit",
        handler: (state) => ({
          ...state,
          async planEdit() {
            const attempt = file.plans;
            file.plans += 1;
            const planned = plan(file.text, attempt);
            writeOnce("before-read");
            return planned;
          },
        }),
      });
    },
  });
  const result = await executeTextMutation(
    core,
    replaceMutationTool,
    { path: source, text: "delta" },
    undefined,
    { cwd: process.cwd() } as ExtensionContext,
  );
  return { file, result };
}

function renameBeta(text: string): TextEditPlan {
  const changes = [...text.matchAll(/beta/gu)].map((match) => ({
    from: match.index,
    to: match.index + "beta".length,
    insert: "delta",
  }));
  if (changes.length === 0) throw new Error("The symbol to rename is gone.");
  return { files: [{ source, expectedContent: text, changes }] };
}

test.each<Window>(["before-read", "before-write"])(
  "a planned edit whose file another process wrote %s is planned again on the current text",
  async (window) => {
    const { file, result } = await renameWithWindowWrite(window, (text) => `other\n${text}`);

    expect(file.text).toBe("other\nalpha delta\ndelta gamma\n");
    expect(file.plans).toBe(2);
    expect(file.writes).toBe(1);
    expect(result.details.results?.[0]?.data.ok).toBe(true);
  },
);

test("a reference that another process added in the window is renamed with the others", async () => {
  const { file } = await renameWithWindowWrite("before-read", (text) => `${text}beta again\n`);

  expect(file.text).toBe("alpha delta\ndelta gamma\ndelta again\n");
});

test("a planned edit whose symbol another process removed in the window writes nothing", async () => {
  const { file, result } = await renameWithWindowWrite("before-read", (text) =>
    text.replaceAll("beta", "BETA"),
  );

  expect(file.text).toBe("alpha BETA\nBETA gamma\n");
  expect(file.plans).toBe(2);
  expect(file.writes).toBe(0);
  expect(result.details.results?.[0]?.data.ok).toBe(false);
  expect(result.details.effect).toBe("not-applied");
});

test("a planner that finds its own source changed gets a new attempt", async () => {
  const { file, result } = await renameWithWindowWrite(
    "before-write",
    (text) => text,
    (text, attempt) => {
      if (attempt === 0)
        throw Object.assign(new Error("Changed during the server request."), {
          code: "SOURCE_CHANGED",
        });
      return renameBeta(text);
    },
  );

  expect(file.text).toBe("alpha delta\ndelta gamma\n");
  expect(file.plans).toBe(2);
  expect(result.details.results?.[0]?.data.ok).toBe(true);
});
