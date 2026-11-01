import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { IDE_PRESENTATION_CHANGED, listenPresentationPreference } from "./live-presentation.js";

function isShutdown(value: unknown): value is () => void {
  return typeof value === "function";
}
test("presentation listeners receive effective values and stop after shutdown", () => {
  const events = new EventEmitter();
  const apply = vi.fn();
  const on = vi.fn();
  const pi: Pick<ExtensionAPI, "events" | "on"> = {
    events: {
      on(name: string, handler: (data: unknown) => void) {
        events.on(name, handler);
        return () => { events.off(name, handler); };
      },
      emit(name: string, data: unknown) { events.emit(name, data); },
    },
    on,
  };
  listenPresentationPreference(pi, "ui.read", apply);
  events.emit(IDE_PRESENTATION_CHANGED, { preferences: { "ui.read": "full" } });
  events.emit(IDE_PRESENTATION_CHANGED, { preferences: {} });
  expect(apply.mock.calls).toEqual([["full"], [undefined]]);
  const shutdown: unknown = on.mock.calls[0]?.[1];
  if (!isShutdown(shutdown)) throw new Error("Missing shutdown handler");
  shutdown();
  events.emit(IDE_PRESENTATION_CHANGED, { preferences: { "ui.read": "disabled" } });
  expect(apply).toHaveBeenCalledTimes(2);
});
