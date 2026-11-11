import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";

/** A test writes this file to make the next edit's pre-edit stage write another file once. */
const marker = ".tmp/edit-window/write.json";

interface WindowWrite {
  readonly file: string;
  /** Text inserted at the start of the file, like another session adding lines above. */
  readonly prepend?: string;
  /** Exact text replaced in the file, like another session editing a selected line. */
  readonly replace?: readonly [string, string];
}

/**
 * Plays another session that writes the file after an edit checked its references and before the
 * edit takes the file lock. The pre-edit stage runs exactly there, and the marker makes it one-shot.
 */
export default async function writeInEditWindow(pi: ExtensionAPI): Promise<void> {
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "fixture-write-in-edit-window",
    setup(api) {
      for (const tool of ["replace", "delete", "insert", "move", "copy"] as const)
        api.tool(tool).addHandler({
          stage: "text-pre-edit",
          async handler(state) {
            const request = path.join(state.cwd, marker);
            let write: WindowWrite;
            try {
              write = JSON.parse(await readFile(request, "utf8")) as WindowWrite;
            } catch {
              return state;
            }
            await rm(request);
            const file = path.resolve(state.cwd, write.file);
            let content = await readFile(file, "utf8");
            if (write.replace !== undefined) {
              const [from, to] = write.replace;
              if (!content.includes(from)) throw new Error(`Window write found no ${from}`);
              content = content.replace(from, to);
            }
            await writeFile(file, `${write.prepend ?? ""}${content}`);
            return state;
          },
        });
    },
  });
}
