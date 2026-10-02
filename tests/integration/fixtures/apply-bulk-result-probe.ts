import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Capture committed bytes, then check the real output reference and receipt-based undo. */
export default function registerBulkResultProbe(pi: ExtensionAPI): void {
  let receipt: string | undefined;
  let fullResult: string | undefined;
  let bridgeResult: string | undefined;
  pi.on("tool_result", async (event, context) => {
    if (event.toolName !== "apply") return;
    const structured = event.structuredContent as { data: { transactions: string[]; fullResult?: string; operations: Array<{ kind: string; fullResult?: string }> } };
    receipt = structured.data.transactions[0];
    fullResult = structured.data.fullResult;
    bridgeResult = structured.data.operations.find((operation) => operation.kind === "mutation")?.fullResult;
    await writeFile(path.join(context.cwd, "edited.bin"), await readFile(path.join(context.cwd, "cases.txt")));
  });
  pi.registerTool(defineTool({
    name: "apply_bulk_result_probe",
    label: "Bulk Apply result probe",
    description: "Read the bulk edit reference and undo its returned receipt.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, context) {
      if (!receipt || !fullResult) throw new Error("Missing committed receipt or output reference");
      const reference = await context.executeTool("read", { path: fullResult, limit: 1 });
      if (!bridgeResult) throw new Error("Missing full bridge reference");
      const bridge = await context.executeTool("read", { path: bridgeResult, limit: 1 });
      if (bridge.isError) throw new Error("Cannot read the full bridge reference");
      const undo = await context.executeTool("undo", { transaction: receipt });
      return {
        content: [{ type: "text", text: JSON.stringify({ referenceError: reference.isError, undoError: undo.isError }) }],
        details: { reference: { isError: reference.isError }, bridge: { isError: bridge.isError }, undo: { isError: undo.isError } },
      };
    },
  }));
}
