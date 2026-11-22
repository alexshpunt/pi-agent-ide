import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_SEARCH_ANCHOR_KIND,
} from "pi-agent-text-editor/api/plugin-protocol";

/**
 * A test writes `{ text, times }` here: the next `times` `BLOCK#` resolutions answer for that
 * earlier text of the file. In Codemode the batch planner resolves once before the edit does.
 */
const earlier = ".tmp/block-targets/earlier.txt";

/**
 * `BLOCK#name` selects the lines from `int name` through the next `}` line, like a language
 * server's declaration. Its first answer can be for a text the file had before another session
 * wrote it, the way a server answers for the version it was last sent.
 */
export default async function blockTargetsReadEarlier(pi: ExtensionAPI): Promise<void> {
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "fixture-block-targets",
    setup(api) {
      api.addAnchorResolver({
        kind: TEXT_SEARCH_ANCHOR_KIND,
        type: "auxiliary",
        describeInPrompt: false,
        resolver: {
          id: "fixture-block",
          description: "Test block selections.",
          renderFull: (value) => value,
          renderCompact: (value) => value,
          tryResolve: () => Promise.resolve({ kind: "not-handled" }),
        },
        resources: {
          id: "fixture-block-targets",
          async tryResolve(value, context) {
            if (!value.startsWith("BLOCK#")) return { kind: "not-handled" };
            const source = path.join(context.cwd, "main.cpp");
            const marker = path.join(context.cwd, earlier);
            let content: string;
            try {
              const answer = JSON.parse(await readFile(marker, "utf8")) as {
                text: string;
                times: number;
              };
              content = answer.text;
              if (answer.times <= 1) await rm(marker);
              else await writeFile(marker, JSON.stringify({ ...answer, times: answer.times - 1 }));
            } catch {
              content = await readFile(source, "utf8");
            }
            const lines = content.split("\n");
            const first = lines.findIndex((line) => line.startsWith(`int ${value.slice(6)}(`));
            const last = lines.findIndex((line, index) => index > first && line === "}");
            if (first === -1 || last === -1)
              return { kind: "rejected", rejection: { code: "missing", reason: "No such block." } };
            return {
              kind: "resolved",
              targets: [
                {
                  source,
                  expectedContent: content,
                  ranges: [
                    {
                      start: { lineNumber: first + 1, column: 0 },
                      end: { lineNumber: last + 2, column: 0 },
                      linewise: true,
                    },
                  ],
                },
              ],
            };
          },
        },
      });
    },
  });
}
