import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectAgentDocumentation } from "pi-agent-documentation";

/** Guides attached by ordinary tools, so attachment checks do not depend on packaged guides. */
export default function registerToolGuides(pi: ExtensionAPI): void {
  connectAgentDocumentation(pi, [
    {
      id: "fixture-insert-guide",
      description: "Insert fixture guide",
      markdown: "# Insert fixture\nFirst insert line.\nSecond insert line.",
      triggers: [{ tool: "insert" }],
    },
    {
      id: "fixture-search-guide",
      description: "Search fixture guide",
      markdown: "# Search fixture\nFirst search line.\nSecond search line.",
      triggers: [{ tool: "search" }],
    },
  ]);
}
