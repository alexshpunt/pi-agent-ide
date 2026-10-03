import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const receiptSchema = Type.Object(
  {
    status: Type.Literal("success"),
    data: Type.Object({ transactions: Type.Array(Type.String()) }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);

/** Forward an actual standalone Apply receipt to native Codemode without exposing Apply there. */
export default function applyReceiptProbe(pi: ExtensionAPI): void {
  let transaction: string | undefined;
  pi.on("tool_result", (event) => {
    if (event.toolName !== "apply" || !Value.Check(receiptSchema, event.structuredContent)) return;
    transaction = event.structuredContent.data.transactions.at(-1);
  });
  pi.registerTool({
    name: "fixture_apply_receipt",
    label: "Fixture Apply receipt",
    exposure: "codemode",
    namespace: { name: "fixture", description: "Integration fixtures." },
    description: "Return the real receipt observed on the last successful standalone Apply.",
    parameters: Type.Object({}),
    outputSchema: Type.Object({ transaction: Type.String() }),
    async execute() {
      if (transaction === undefined) throw Error("No Apply receipt was observed");
      return {
        content: [{ type: "text", text: transaction }],
        details: {},
        structuredContent: { transaction },
      };
    },
  });
}
