import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Type } from "typebox";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const outsideWriteSchema = Type.Object(
  {
    path: Type.String(),
    content: Type.String(),
  },
  { additionalProperties: false },
);

export default function registerOutsideWrite(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "outside_write",
    label: "outside_write",
    description: "Write a fixture file without using the text editor.",
    parameters: outsideWriteSchema,
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      await writeFile(path.resolve(context.cwd, parameters.path), parameters.content, "utf8");
      return { content: [{ type: "text", text: "outside write complete" }], details: null };
    },
  });
}
