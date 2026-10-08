import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Carry the actual public child target across cancellation without relying on aborted sandbox state. */
export default function registerMutationTargetRejectionFixture(pi: ExtensionAPI): void {
  let acceptedTarget: string | undefined;
  pi.on("tool_result", (event) => {
    if (event.parentToolCallId !== "cancel" || event.toolName !== "replace") return;
    const shown = event.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    acceptedTarget = /<uuid>([a-f\d-]{36})<\/uuid>/iu.exec(shown)?.[1];
  });
  pi.on("tool_call", (event) => {
    if (event.toolCallId !== "rejected" || event.toolName !== "codemode") return;
    if (acceptedTarget === undefined)
      throw Error("The producer did not return a public reserved target");
    if (typeof event.input.code !== "string") throw Error("Expected the rejection script");
    event.input.code = event.input.code.replace(
      '"owned-cancelled-target"',
      JSON.stringify(acceptedTarget),
    );
  });
}
