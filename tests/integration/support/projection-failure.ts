import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createIdeTextResults } from "#src/composite/text-results.ts";
import { textValue } from "#src/composite/script-values/text.ts";

/** Exercise the production result hooks with a deterministic failing projection. */
export default function projectionFailure(pi: ExtensionAPI) {
  const original = textValue.project;
  textValue.project = (input) => {
    if (input.script) {
      textValue.project = original;
      throw new Error("projection fixture failure");
    }
    return original(input);
  };
  pi.on("session_shutdown", () => {
    textValue.project = original;
  });
  const results = createIdeTextResults(pi);
  results.api.registerTool({
    name: "fixture",
    label: "Fixture",
    description: "Return a fixture",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "private fixture content" }],
        structuredContent: { status: "success", data: { secret: "private fixture content" } },
        details: {},
      };
    },
  });
  results.finalize();
}
