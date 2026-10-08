import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Forward only this scenario's actual public Apply receipt and restored target. */
export default function registerRestoreTargetFixture(pi: ExtensionAPI): void {
  let receipt: string | undefined;
  let target: string | undefined;
  pi.on("tool_result", (event) => {
    if (event.toolCallId === "checkpoint")
      receipt = /APPLY#[0-9A-F]{12}/u.exec(JSON.stringify(event.content))?.[0];
    if (event.toolCallId !== "restore") return;
    const result: unknown = event.structuredContent;
    if (result === null || typeof result !== "object" || !("data" in result)) return;
    const data = result.data;
    if (
      data !== null &&
      typeof data === "object" &&
      "target" in data &&
      typeof data.target === "string"
    )
      target = data.target;
  });
  pi.on("tool_call", (event) => {
    if (event.toolCallId === "restore" && event.toolName === "undo") {
      if (receipt === undefined) throw Error("No actual Apply receipt");
      event.input.transaction = receipt;
    }
    if (event.toolCallId === "restored-scope" && event.toolName === "codemode") {
      if (target === undefined || typeof event.input.code !== "string")
        throw Error("No actual restored text target");
      event.input.code = event.input.code.replace(
        '"owned-restored-target"',
        JSON.stringify(target),
      );
    }
  });
}
