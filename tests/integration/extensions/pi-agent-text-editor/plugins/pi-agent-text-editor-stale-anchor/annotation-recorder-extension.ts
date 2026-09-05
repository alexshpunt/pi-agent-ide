import { appendFileSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ANNOTATION_EVENTS_LOG = "annotation-events.log";

const TOOL_CALL_ANNOTATION_EVENT = "pi-agent-text-editor/tool-call-annotation";

/**
 * Records every tool-call annotation event the interceptor emits, so tests can
 * assert exactly which tool calls got annotated.
 */
export default function recordToolCallAnnotations(pi: ExtensionAPI): void {
  let cwd: string | undefined;

  pi.on("session_start", (_event, context) => {
    cwd = context.cwd;
  });
  pi.on("turn_start", (_event, context) => {
    cwd ??= context.cwd;
  });

  pi.events.on(TOOL_CALL_ANNOTATION_EVENT, (event) => {
    if (cwd === undefined) {
      return;
    }

    appendFileSync(path.join(cwd, ANNOTATION_EVENTS_LOG), `${JSON.stringify(event)}\n`, "utf8");
  });
}
