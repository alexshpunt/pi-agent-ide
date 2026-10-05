import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Stand in for a user forwarding the last real tool result to the next direct call. */
export default function forwardResult(pi: ExtensionAPI) {
  let shown = "";
  pi.on("tool_execution_end", (event) => {
    const result: unknown = event.result;
    if (result === null || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return;
    const content: unknown[] = result.content;
    shown = content.flatMap(block => block !== null && typeof block === "object" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("\n");
  });
  pi.on("tool_call", (event) => {
    const input = event.input as Record<string, unknown>;
    if (input.path === "$previous-result") input.path = shown;
    if (input.path === "$previous-uuid") {
      const id = /<uuid>([^<]+)<\/uuid>/u.exec(shown)?.[1];
      if (!id) throw new Error("The previous result did not issue a UUID");
      input.path = id;
    }
  });
}
