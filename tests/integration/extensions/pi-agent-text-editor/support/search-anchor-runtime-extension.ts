import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const PLACEHOLDER = /^SEARCH#RUNTIME:(\d+):(all|[1-9]\d*):(line|match)$/u;
const LINE_PLACEHOLDER = /^LINE#RUNTIME:(\d+)$/u;
const ANCHOR = /SEARCH#([A-F0-9]{4,64}):(all|[1-9]\d*):(line|match)/gu;
const LINE_ANCHOR = /(?<![A-Za-z0-9])([1-9]\d*#[A-Z0-9]{3,4})\|/u;

/**
 * Rewrites test placeholders with the search-session ID produced inside the
 * actual Pi workspace. Shared pi-test runs stage the caller's workspace into
 * a different runtime cwd, so IDs computed by the Vitest process are not
 * valid inside Pi.
 */
export default function registerSearchAnchorRuntimeExtension(pi: ExtensionAPI): void {
  let sessionIds: string[] = [];
  let lineAnchors: string[] = [];

  pi.on("session_start", () => {
    sessionIds = [];
    lineAnchors = [];
  });

  pi.on("tool_result", (event: ToolResultEvent) => {
    const text = event.content
      .filter(
        (content): content is { readonly type: "text"; readonly text: string } =>
          content.type === "text",
      )
      .map((content) => content.text)
      .join("\n");

    if (event.toolName === "search") {
      const details = event.details;
      const payload = isRecord(details) ? details.payload : undefined;
      if (isRecord(payload) && typeof payload.sessionId === "string") {
        sessionIds.push(payload.sessionId);
        return;
      }

      const id = text.match(ANCHOR)?.[1];
      if (id !== undefined) {
        sessionIds.push(id);
      }
      return;
    }

    if (event.toolName === "read") {
      const anchor = text.match(LINE_ANCHOR)?.[1];
      if (anchor !== undefined) {
        lineAnchors.push(anchor);
      }
    }
  });

  pi.on("tool_call", (event: ToolCallEvent) => {
    rewriteInput(event.input, sessionIds, lineAnchors);
  });
}

function rewriteInput(
  input: Record<string, unknown>,
  sessionIds: readonly string[],
  lineAnchors: readonly string[],
): void {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      let resolved = value.replace(
        PLACEHOLDER,
        (_full, index: string, selector: string, mode: string) => {
          const sessionId = sessionIds.at(Number(index) - 1);
          return sessionId === undefined ? _full : `SEARCH#${sessionId}:${selector}:${mode}`;
        },
      );
      resolved = resolved.replace(
        LINE_PLACEHOLDER,
        (_full, index: string) => lineAnchors.at(Number(index) - 1) ?? _full,
      );
      input[key] = resolved;
      continue;
    }

    if (isRecord(value)) {
      rewriteInput(value, sessionIds, lineAnchors);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
