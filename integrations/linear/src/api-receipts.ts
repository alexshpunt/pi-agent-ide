import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TextEditorPluginApi } from "pi-agent-ide/api/text-editor";
import { parseLinearApiAddress } from "./api.ts";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Raw requests have no file diff; keep their call header bounded and truthful. */
export function registerLinearApiRenderer(api: Pick<TextEditorPluginApi, "addToolRenderer">): void {
  api.addToolRenderer({
    tool: "write",
    matches(value, phase) {
      const input = object(value);
      return (
        phase === "call" &&
        typeof input?.path === "string" &&
        parseLinearApiAddress(input.path)?.kind === "request"
      );
    },
    renderCall(args, theme) {
      const input = object(args);
      const bytes =
        typeof input?.content === "string" ? Buffer.byteLength(input.content, "utf8") : 0;
      return new Text(
        theme.fg("toolTitle", `write ${typeof input?.path === "string" ? input.path : ""}`) +
          "\n" +
          theme.fg("muted", `GraphQL request · ${bytes} bytes`),
        0,
        0,
      );
    },
  });
}
/** Failed raw calls keep their explicit effect in the shared Write renderer. */
export function connectLinearApiReceipts(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "write" && event.toolName !== "linear_write") return;
    const details = object(event.details);
    const action = object(object(details?.metadata)?.semanticAction);
    if (
      action?.kind !== "linear-graphql" ||
      action.ok !== false ||
      typeof action.source !== "string" ||
      typeof action.request !== "string" ||
      typeof action.effect !== "string" ||
      !["applied", "not-applied", "unknown"].includes(action.effect)
    )
      return;
    const source = parseLinearApiAddress(action.source);
    const request = parseLinearApiAddress(action.request);
    if (
      source?.kind !== "result" ||
      request?.kind !== "request" ||
      source.workspace !== request.workspace ||
      source.workspace !== action.workspace
    )
      return;
    return { isError: true, details: { ...details, effect: action.effect } };
  });
}
