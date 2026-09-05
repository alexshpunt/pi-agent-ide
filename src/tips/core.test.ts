import { describe, expect, test } from "vitest";

import { TIP_API_VERSION, TIP_PROTOCOL, type TipProvider } from "#src/api/tips.js";
import { TipCore } from "./core.js";

const context = {
  cwd: "/project",
  mode: "tui" as const,
  hasUI: true,
  reason: "startup" as const,
};

function provider(id: string, getTip: TipProvider["getTip"]): TipProvider {
  return { protocol: TIP_PROTOCOL, apiVersion: TIP_API_VERSION, id, getTip };
}

describe("TipCore", () => {
  test("collects valid tips while isolating a provider failure", async () => {
    const core = new TipCore();
    await core.registerProvider(provider("broken", () => Promise.reject(new Error("broken"))));
    await core.registerProvider(
      provider("working", () => ({ id: "working-tip", title: "Title", body: "Body" })),
    );

    await expect(core.collectTips(context)).resolves.toEqual([
      { providerId: "working", tip: { id: "working-tip", title: "Title", body: "Body" } },
    ]);
  });

  test("releases cancelled collection even when a provider ignores its signal", async () => {
    const core = new TipCore();
    const controller = new AbortController();
    let reject = (_error: Error): void => {};
    const promise = new Promise<undefined>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    let suppliedSignal: AbortSignal | undefined;
    let laterCalled = false;
    await core.registerProvider(
      provider("slow", (input) => {
        suppliedSignal = input.signal;
        return promise;
      }),
    );
    await core.registerProvider(
      provider("later", () => {
        laterCalled = true;
        return undefined;
      }),
    );
    const collection = core.collectTips({ ...context, signal: controller.signal });
    controller.abort();
    await expect(collection).resolves.toEqual([]);
    expect(suppliedSignal?.aborted).toBe(true);
    expect(laterCalled).toBe(false);
    reject(new Error("Late provider failure is already handled"));
  });

  test("rejects duplicate provider IDs", async () => {
    const core = new TipCore();
    const first = provider("same", () => undefined);
    await core.registerProvider(first);

    await expect(core.registerProvider(provider("same", () => undefined))).rejects.toThrow(
      "already registered",
    );
  });
});
