import { describe, expect, it, vi } from "vitest";

import {
  type PartialToolRecoveryRegistration,
  PartialToolRecoveryRegistry,
} from "#src/core/tool-call-interceptor/partial-tool-recovery.js";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const ctx = {} as ExtensionContext;

function registration(
  execute: PartialToolRecoveryRegistration["execute"],
): PartialToolRecoveryRegistration {
  return {
    toolName: "replace",
    extractEntries: () => [
      { index: 0, value: { path: "a", text: "one" }, complete: true },
      { index: 1, value: { path: "b" }, complete: false },
      { index: 2, value: { path: "c", text: "stale" }, complete: true },
      { index: 3, value: { path: "d", text: "after" }, complete: true },
    ],
    isCompleteEntry: (entry) => entry.complete && typeof entry.value.text === "string",
    buildParams: (entries) => ({ edits: entries.map((entry) => entry.value) }),
    execute,
  };
}

describe("PartialToolRecoveryRegistry", () => {
  it("executes only complete entries before the stale entry", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const registry = new PartialToolRecoveryRegistry();
    registry.register(registration(execute));

    const result = await registry.recover({
      contentIndex: 4,
      toolCallId: "call-4",
      toolName: "replace",
      staleEntryIndex: 2,
      staleDetails: { entryIndex: 2 },
      partialArgs: {},
      args: {},
      cwd: "/tmp",
      ctx,
    });

    expect(result?.status).toBe("recovered");
    expect(result?.appliedEntries).toEqual([0]);
    expect(result?.skippedEntries).toEqual([
      { index: 1, reason: "entry was incomplete before the stale entry" },
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      { edits: [{ path: "a", text: "one" }] },
      expect.objectContaining({ contentIndex: 4 }),
    );
  });

  it("runs recovery at most once and isolates content indexes", async () => {
    const execute = vi.fn(async () => ({}));
    const registry = new PartialToolRecoveryRegistry();
    registry.register(registration(execute));
    const input = {
      contentIndex: 1,
      toolCallId: "call-1",
      toolName: "replace",
      staleEntryIndex: 2,
      staleDetails: {},
      args: {},
      cwd: "/tmp",
      ctx,
    };

    const first = await registry.recover(input);
    const second = await registry.recover(input);
    const other = await registry.recover({ ...input, contentIndex: 2 });

    expect(first).toBe(second);
    expect(other?.contentIndex).toBe(2);
    expect(execute).toHaveBeenCalledTimes(2);

    registry.cleanup(1);
    await registry.recover(input);
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it("skips entries that already completed before recovery", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const registry = new PartialToolRecoveryRegistry();
    registry.register(registration(execute));

    const result = await registry.recover({
      contentIndex: 5,
      toolCallId: "call-5",
      toolName: "replace",
      staleEntryIndex: 3,
      staleDetails: { entryIndex: 3 },
      args: {},
      completedEntryIndexes: [0],
      cwd: "/tmp",
      ctx,
    });

    expect(result?.appliedEntries).toEqual([2]);
    expect(result?.skippedEntries).toContainEqual({
      index: 0,
      reason: "entry already completed before recovery",
    });
    expect(execute).toHaveBeenCalledWith(
      { edits: [{ path: "c", text: "stale" }] },
      expect.objectContaining({ contentIndex: 5 }),
    );
  });
});
