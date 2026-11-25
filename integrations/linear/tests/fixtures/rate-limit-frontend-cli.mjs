import { appendFile, readFile } from "node:fs/promises";
import { encode } from "@toon-format/toon-v4";

const scenario = JSON.parse(await readFile("rate-limit-scenario.json", "utf8"));
const [group, action, operation] = process.argv.slice(2);
await appendFile("calls.jsonl", JSON.stringify({ group, action, operation }) + "\n");
const error = "LINEAR_OPERATION_RATE_LIMITED";
if (group === "resources" && action === "capabilities" && scenario.mode !== "preflight") {
  console.log(
    encode({
      capabilities: {
        workspace: "example",
        items: [
          {
            name: "get_project",
            inputSchema: JSON.stringify({
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            }),
            annotations: "{}",
          },
        ],
      },
    }),
  );
} else if (group === "resources" && action === "invoke" && scenario.mode !== "preflight") {
  console.log(
    encode({
      invocation: {
        workspace: "example",
        operation,
        effect: "not-applied",
        error,
        data: "null",
        rateLimit: scenario.rateLimit,
      },
    }),
  );
} else {
  console.log(
    encode({
      error: scenario.mode === "preflight" ? "LINEAR_CAPABILITIES_RATE_LIMITED" : error,
      rateLimit: scenario.rateLimit,
      privateBody: "fixture-private-body",
    }),
  );
  process.exitCode = 1;
}
