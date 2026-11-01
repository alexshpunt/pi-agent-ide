import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { createLiveFeatureFlag, IDE_FEATURE_FLAGS_CHANGED } from "./live-feature-flag.js";

function isShutdown(value: unknown): value is () => void {
  return typeof value === "function";
}
function fixture(initial: boolean, argv: string[]) {
  const bus = new EventEmitter();
  const handlers = vi.fn();
  const pi: Pick<ExtensionAPI, "events" | "on" | "getFlag"> = {
    getFlag: () => initial,
    on: handlers,
    events: {
      on(name, handler) { bus.on(name, handler); return () => { bus.off(name, handler); }; },
      emit(name, data) { bus.emit(name, data); },
    },
  };
  const read = createLiveFeatureFlag(pi, "flag", false, argv);
  return { bus, handlers, read };
}

test("saved flags apply immediately and reset to their default", () => {
  const { bus, read, handlers } = fixture(false, []);
  expect(read()).toBe(false);
  bus.emit(IDE_FEATURE_FLAGS_CHANGED, { flags: { flag: true } });
  expect(read()).toBe(true);
  bus.emit(IDE_FEATURE_FLAGS_CHANGED, { flags: {} });
  expect(read()).toBe(false);
  const shutdown: unknown = handlers.mock.calls[0]?.[1];
  if (!isShutdown(shutdown)) throw new Error("Missing shutdown handler");
  shutdown();
  bus.emit(IDE_FEATURE_FLAGS_CHANGED, { flags: { flag: true } });
  expect(read()).toBe(false);
});

test("explicit command line flags override saved settings", () => {
  const { bus, read } = fixture(true, ["--flag"]);
  bus.emit(IDE_FEATURE_FLAGS_CHANGED, { flags: { flag: false } });
  expect(read()).toBe(true);
});
