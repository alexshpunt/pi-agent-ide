import { encode } from "@toon-format/toon-v4";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { NativeWorkflowClient } from "#linear-axi/src/native-workflow.ts";
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
const workspace = "example";
const id = "20000000-0000-4000-8000-000000000002";
const state = "template-fixture.json";
if (args[0] === "auth" && args[1] === "epoch") {
  console.log(JSON.stringify({ epoch: "legacy", state: "legacy" }));
  process.exit(0);
}
appendFileSync("axi-calls.jsonl", JSON.stringify(args) + "\n");
const capabilities = new NativeWorkflowClient({ tokenProvider: {} }).capabilities();
capabilities.push({
  name: "get_template",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
});
if (args[0] !== "resources") throw Error("Unexpected group");
if (args[1] === "capabilities") {
  console.log(
    encode({
      capabilities: {
        workspace,
        items: capabilities.map((c) => ({
          name: c.name,
          inputSchema: JSON.stringify(c.inputSchema),
          annotations: JSON.stringify(c.annotations),
        })),
      },
    }),
  );
} else if (args[1] === "invoke") {
  const operation = args[2];
  const input = JSON.parse(readFileSync(value("--input-file"), "utf8"));
  let template = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null;
  if (operation === "create_workflow_template") {
    if (input.name === "Uncertain fixture") {
      console.log(
        encode({
          invocation: {
            workspace,
            operation,
            effect: "unknown",
            error: "LINEAR_NATIVE_WRITE_UNKNOWN",
            targetId: "20000000-0000-4000-8000-000000000003",
          },
        }),
      );
      process.exit(0);
    }
    if (template) throw Error("Creation was replayed");
    template = {
      id,
      name: input.name,
      type: input.type,
      description: input.description ?? null,
      teamId: input.teamId ?? null,
      scope: input.teamId ? "team" : "workspace",
      templateData: JSON.stringify({ title: input.title, descriptionData: input.descriptionData }),
    };
  } else if (operation === "update_workflow_template") {
    if (input.id !== template?.id) throw Error("Wrong update target");
    template.templateData = JSON.stringify({
      ...JSON.parse(template.templateData),
      descriptionData: input.descriptionData,
    });
  } else if (
    !["get_workflow_template", "get_template"].includes(operation) ||
    input.id !== template?.id
  )
    throw Error("Unexpected read");
  writeFileSync(state, JSON.stringify(template));
  console.log(
    encode({
      invocation: {
        workspace,
        operation,
        effect: "applied",
        data: JSON.stringify(template),
        ...(!operation.startsWith("get_") ? { targetId: id } : {}),
      },
    }),
  );
} else throw Error("Unexpected action");
