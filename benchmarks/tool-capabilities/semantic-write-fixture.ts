import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_PROTOCOL, READ_API_VERSION } from "pi-agent-ide/api/read";
import { ResourceError } from "pi-agent-ide/api/resource";
import {
  connectTextEditorPlugin,
  TEXT_EDITOR_PROTOCOL,
  TEXT_EDITOR_API_VERSION,
} from "pi-agent-ide/api/text-editor";

const semanticSource = /^fixture:semantic(?:-script)?\/(applied|not-applied|unknown)$/;
const scriptSource = /^fixture:semantic-script\/(applied|not-applied|unknown)$/;

/** Synthetic provider failures and semantic actions; no external service or native input. */
export default async function semanticWriteFixture(pi: ExtensionAPI): Promise<void> {
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "capability-read-provider",
    setup(api) {
      api.addResolver({
        priority: -200,
        resolver: {
          id: "capability-read-provider",
          async tryResolve(source, context) {
            if (source !== "fixture:read-provider#metadata" && source !== "fixture:read-provider")
              return { kind: "not-handled" };
            await appendFile(
              path.join(context.cwd, "provider-reads.jsonl"),
              JSON.stringify(source) + "\n",
            );
            if (source.endsWith("#metadata"))
              return {
                kind: "failed",
                error: new ResourceError("FIXTURE_FIELD_UNAVAILABLE", source, "not-applied"),
              };
            return {
              kind: "resolved",
              resource: {
                source,
                read: async () => [{ type: "text", text: "metadata metadata\n" }],
              },
            };
          },
        },
      });
    },
  });
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "capability-semantic-write",
    setup(api) {
      api.addResolver({
        priority: -200,
        resolver: {
          id: "capability-semantic-write",
          async tryResolve(source) {
            if (!semanticSource.test(source)) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                skipPostEdit: true,
                read: async () => [
                  {
                    type: "text",
                    text: "Synthetic action descriptor; no native input or file write.",
                  },
                ],
              },
            };
          },
        },
      });
      for (const [tool, field, sources] of [
        ["write", "content", semanticSource],
        ["insert", "text", scriptSource],
      ] as const) {
        api.tool(tool).addSemanticHandler({
          matches: (input) =>
            typeof input === "object" &&
            input !== null &&
            "path" in input &&
            typeof input.path === "string" &&
            sources.test(input.path),
          async execute(context, input) {
            if (typeof input !== "object" || input === null)
              throw new Error("The synthetic action requires literal input.");
            const literal = (input as Record<string, unknown>)[field];
            if (typeof literal !== "string")
              throw new Error("The synthetic action requires literal input.");
            const source = context.sourceFor("path"),
              effect = source.slice(source.lastIndexOf("/") + 1);
            await appendFile(
              path.join(context.cwd, "attempts.jsonl"),
              JSON.stringify({ effect, [field]: literal }) + "\n",
            );
            const data = {
              kind: "fixture-action",
              ok: effect === "applied",
              effect,
              receipt: { attempted: 1, delivered: effect !== "not-applied" },
            };
            return {
              source,
              summary: `Semantic action ${effect}; attempted prefix retained. Never replay unknown effects.`,
              data,
              // The unpredictable value is available only through the structured script receipt.
              ...(scriptSource.test(source) && { script: { ...data, nonce: randomUUID() } }),
            };
          },
        });
      }
    },
  });
}
