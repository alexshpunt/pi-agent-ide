import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  RESULT_TARGET_STORE_VERSION,
  ResultTargetStore,
  connectResultTargets,
  type ResolvedResultTargets,
  type ResultSourceTarget,
} from "./result-targets.ts";

const event = "pi-agent-resource:result-targets";
const target: ResultSourceTarget = {
  source: "github:owner/repo/README.md",
  expectedContent: "alpha\n",
  ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 5 } }],
};

/** The parts of Pi's extension API that the store connection uses, on one shared event bus. */
function fakePi(): ExtensionAPI {
  const pi: Partial<ExtensionAPI> = { events: createEventBus(), on: () => () => {} };
  return pi as ExtensionAPI;
}

/**
 * A store from an older copy of this package, such as the SDK 0.9.8 bundled by another
 * extension: no version and no `resolveCurrent`, shared through the same event protocol.
 */
class OlderStore {
  readonly #entries = new Map<string, ResolvedResultTargets>();
  public register(targets: readonly ResultSourceTarget[], _cwd: string, complete = true): string {
    const reference = `RESULT#older-${String(this.#entries.size)}`;
    this.#entries.set(reference, { targets, complete });
    return reference;
  }
  public resolve(input: unknown, _cwd: string): ResolvedResultTargets {
    const entry = typeof input === "string" ? this.#entries.get(input) : undefined;
    if (entry === undefined)
      throw new Error("Result target expired or unknown; repeat Read/Search.");
    return entry;
  }
  public invalidate(): void {}
  public clear(): void {
    this.#entries.clear();
  }
}

/** The connection of the older copy: it adopts any offered store or creates and offers its own. */
function connectOlder(pi: ExtensionAPI): OlderStore {
  let existing: OlderStore | undefined;
  pi.events.emit(event, {
    accept: (store: OlderStore) => {
      existing = store;
    },
  });
  if (existing !== undefined) return existing;
  const store = new OlderStore();
  pi.events.on(event, (request) => {
    (request as { accept: (store: OlderStore) => void }).accept(store);
  });
  return store;
}

describe("sharing the result store between copies of this package", () => {
  test("copies of the same version share the first store", () => {
    const pi = fakePi();
    const first = connectResultTargets(pi);
    expect(first.version).toBe(RESULT_TARGET_STORE_VERSION);
    expect(connectResultTargets(pi)).toBe(first);
  });

  test("a store from an older copy loaded first forwards its calls to the current store", async () => {
    const pi = fakePi();
    const older = connectOlder(pi);
    const store = connectResultTargets(pi);
    expect(store).toBeInstanceOf(ResultTargetStore);
    expect(store).not.toBe(older);

    // The older copy keeps its reference; what it registers is resolved by the current store.
    const reference = older.register(
      [{ ...target, readCurrent: () => Promise.resolve(target.expectedContent) }],
      "/workspace",
    );
    expect(reference).toMatch(/^RESULT#[a-f\d-]{36}$/u);
    const current = await store.resolveCurrent(reference, "/workspace");
    expect(current.targets.map(({ source, ranges }) => ({ source, ranges }))).toEqual([
      { source: target.source, ranges: target.ranges },
    ]);
    expect(older.resolve(reference, "/workspace")).toEqual(store.resolve(reference, "/workspace"));
  });

  test("an older copy loaded later gets the current store", () => {
    const pi = fakePi();
    const older = connectOlder(pi);
    const store = connectResultTargets(pi);
    expect(connectOlder(pi)).toBe(store);
    expect(connectResultTargets(pi)).toBe(store);
    // The first older store forwards to the same store.
    const reference = older.register([target], "/workspace");
    expect(store.resolve(reference, "/workspace").targets).toHaveLength(1);
  });
});
