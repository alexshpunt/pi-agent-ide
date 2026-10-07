import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerIde from "#src/pi-agent-ide.js";

/** Inspect saved output while the real runtime still owns its temporary files. */
export default async function outputRetentionIde(pi: ExtensionAPI) {
  await registerIde(pi);
  const saved = new Map<string, { files: string[]; bytes: number; tail: string }>();
  pi.on("context", async (event, context) => {
    for (const message of event.messages) {
      if (message.role !== "toolResult") continue;
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      const match = /Full output: ("(?:\\.|[^"\\])*")/u.exec(text);
      if (!match?.[1]) continue;
      const file: unknown = JSON.parse(match[1]);
      if (typeof file !== "string") throw new Error("Full output reference is not a path");
      const full = await readFile(file, "utf8");
      const info = await stat(file);
      if ((info.mode & 0o777) !== 0o600) throw new Error("Full output file is not private");
      const previous = saved.get(message.toolCallId);
      const files = [...new Set([...(previous?.files ?? []), file])];
      saved.set(message.toolCallId, {
        files,
        bytes: Buffer.byteLength(full),
        tail: full.slice(-200),
      });
    }
    await writeFile(
      path.join(context.cwd, "retention-audit.json"),
      JSON.stringify(Object.fromEntries(saved)),
    );
  });
}
