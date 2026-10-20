import { appendFileSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL } from "pi-agent-read/api/plugin-protocol";
import type { ReadableResource } from "pi-agent-resource";

/** Two distinct one-pixel PNG frames returned by the fixture-frames: Read source. */
export const FIXTURE_FRAMES: readonly [string, string] = [
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
];

/**
 * A two-frame Read source and a deterministic image classifier for Codemode tests. The classifier
 * records each received image and answers "red" for PNG input, an error for state.fail and an
 * abort for state.abort.
 */
export default async function imageClassifierFixture(pi: ExtensionAPI): Promise<void> {
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "image-frames-fixture",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "fixture-frames",
          async tryResolve(source) {
            if (source !== "fixture-frames:") return { kind: "not-handled" as const };
            const resource: ReadableResource = {
              source,
              read: async () => [
                { type: "image", data: FIXTURE_FRAMES[0], mimeType: "image/png" },
                { type: "image", data: FIXTURE_FRAMES[1], mimeType: "image/png" },
              ],
            };
            return { kind: "resolved" as const, resource };
          },
        },
      });
    },
  });
  pi.registerProvider("fixture-vision", {
    apiKey: "fixture",
    models: [
      {
        type: "classifier",
        id: "colour",
        name: "Fixture colour classifier",
        api: "fixture-classifier",
        baseUrl: "http://fixture.invalid",
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
      },
    ],
    classifiers: {
      "fixture-classifier": {
        classify: async (model, context) => {
          appendFileSync(
            path.join(process.cwd(), "classifier-calls.jsonl"),
            `${JSON.stringify({
              state: context.state,
              images: (context.images ?? []).map(({ type, data, mimeType }) => ({
                type,
                data,
                mimeType,
              })),
            })}\n`,
          );
          const base = {
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            answers: {},
          };
          if (context.state.abort === true) return { ...base, stopReason: "aborted" as const };
          if (context.state.fail === true)
            return { ...base, stopReason: "error" as const, errorMessage: "fixture failure" };
          const red = context.images?.some((image) => image.mimeType === "image/png") === true;
          return {
            ...base,
            stopReason: "stop" as const,
            answers: {
              colour: {
                type: "choice" as const,
                choice: red ? "red" : "unknown",
                probabilities: { red: red ? 1 : 0, unknown: red ? 0 : 1 },
                confidence: 1,
              },
            },
          };
        },
      },
    },
  });
}
