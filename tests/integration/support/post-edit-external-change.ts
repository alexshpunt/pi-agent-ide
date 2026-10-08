import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Change a test file outside the editor so final processing must revalidate it. */
export default function postEditExternalChange(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "post_edit_external_change",
    label: "Change test file",
    description: "Change a test file outside the editor after its write is confirmed.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute(_id, input, _signal, _update, context) {
      await writeFile(path.resolve(context.cwd, input.path), input.content);
      return {
        content: [{ type: "text", text: "Changed test file outside the editor." }],
        details: {},
      };
    },
  });
}
