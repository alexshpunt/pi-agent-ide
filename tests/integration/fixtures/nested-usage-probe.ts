import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Adds known billing to real Read calls without replacing their results or renderers. */
export default function nestedUsageProbe(pi: ExtensionAPI): void {
  pi.registerProvider("nested-fixture", {
    apiKey: "unused-fixture-key",
    models: [{
      type: "classifier",
      id: "retained-classifier",
      name: "Retained classifier",
      api: "nested-fixture-api",
      baseUrl: "https://fixture.invalid",
      input: ["text"],
      cost: { input: 25000, output: 25000, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
    }],
    classifiers: {
      "nested-fixture-api": {
        async classify(model) {
          return {
            api: model.api,
            provider: model.provider,
            model: model.id,
            answers: { passed: { type: "bool", probability: 1 } },
            usage: {
              input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
              cost: { input: 0.1, output: 0.025, cacheRead: 0, cacheWrite: 0, total: 0.125 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      },
    },
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read" || event.input.path !== "billable.txt") return;
    return {
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0.2, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.25 },
      },
    };
  });
}
