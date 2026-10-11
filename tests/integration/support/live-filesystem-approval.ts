import { setTimeout as pause } from "node:timers/promises";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Load explicitly for live checks; forwards inspect_tui pixels while a real approval waits. */
export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "filesystem_approval_probe",
    label: "Filesystem approval probe",
    description:
      "Run Delete on a disposable fixture and return the exact Herdr viewport captured while its approval dialog waits. Only use with a task-owned fixture and explicit live-check permission.",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
    async execute(_id, input, signal, _update, ctx) {
      const operation = ctx.executeTool("delete", { path: input.path }, { signal });
      const capture = (async () => {
        await pause(3000, undefined, { signal });
        return ctx.executeTool("inspect_tui", {}, { signal });
      })();
      const [removed, captured] = await Promise.allSettled([operation, capture]);
      const content: AgentToolResult<undefined>["content"] = [];
      if (captured.status === "fulfilled") content.push(...captured.value.result.content);
      else content.push({ type: "text", text: `Capture failed: ${String(captured.reason)}` });
      if (removed.status === "fulfilled") content.push(...removed.value.result.content);
      else content.push({ type: "text", text: `Delete failed: ${String(removed.reason)}` });
      return { content, details: undefined };
    },
  });
}
