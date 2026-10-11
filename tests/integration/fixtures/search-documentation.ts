import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectAgentDocumentation } from "pi-agent-documentation";

/** Registered guide bodies let search checks avoid pinning production guide wording. */
export default function registerSearchDocumentation(pi: ExtensionAPI): void {
  connectAgentDocumentation(pi, [
    {
      id: "search-fixture-one",
      description: "First search fixture",
      markdown: "# First\nunique-doc-needle one\nunique-doc-needle two",
      triggers: [{ tool: "read", resourcePrefixes: ["example.ts"] }],
    },
    {
      id: "search-fixture-two",
      description: "Second search fixture",
      markdown: "# Second\nunique-doc-needle three",
      triggers: [{ tool: "read", resourcePrefixes: ["unused.ts"] }],
    },
  ]);
}
