import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deterministic classifier at Pi's real provider boundary; no network or real credentials. */
export default async function registerReviewFixture(pi: ExtensionAPI): Promise<void> {
  const { mode } = JSON.parse(await readFile(path.resolve("review-case.json"), "utf8")) as {
    mode: string;
  };
  pi.registerProvider("typesafe", {
    ...(mode === "disconnected" ? {} : { apiKey: "test-key" }),
    models:
      mode === "disconnected"
        ? []
        : [
            {
              type: "classifier",
              id: "jev-test",
              name: "Jev fixture",
              api: "review-test",
              input: ["text"],
              contextWindow: 32768,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
    classifiers: {
      "review-test": {
        async classify(model, context) {
          await appendFile(path.resolve("review-calls.jsonl"), JSON.stringify(context) + "\n");
          return {
            api: "review-test",
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            stopReason: mode === "failure" ? "error" : "stop",
            ...(mode === "failure" ? { errorMessage: "Fixture provider failed" } : {}),
            answers: Object.fromEntries(
              Object.keys(context.questions).map((id) => [
                id,
                {
                  type: "choice",
                  choice: "violation",
                  confidence: 0.95,
                  probabilities: { violation: 0.95, clear: 0.03, unknown: 0.02 },
                },
              ]),
            ),
          } satisfies ClassifierResult;
        },
      },
    },
  });
  pi.registerTool({
    name: "wait_review",
    label: "Wait for background review",
    description: "Wait briefly for background review in a deterministic test.",
    parameters: Type.Object({}),
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return { content: [{ type: "text", text: "Background wait finished." }], details: undefined };
    },
  });
}
