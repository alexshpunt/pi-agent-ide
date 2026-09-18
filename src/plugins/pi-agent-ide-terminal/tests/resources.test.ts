import { describe, expect, test } from "vitest";

import { parseTerminalVisualView } from "#src/plugins/pi-agent-ide-terminal/src/resources.js";

describe("terminal visual views", () => {
  test("parses a bounded sequence with scale", () => {
    expect(parseTerminalVisualView(["sequence:duration=1,interval=0.5,scale=0.25"])).toEqual({
      mode: "sequence",
      duration: 1,
      interval: 0.5,
      scale: 0.25,
    });
  });

  test("keeps still image defaults", () => {
    expect(parseTerminalVisualView(["image"])).toEqual({
      mode: "image",
      duration: 2,
      interval: 0.5,
      scale: 1,
    });
  });

  test("rejects oversized sequences and unsupported parameters", () => {
    expect(() => parseTerminalVisualView(["sequence:duration=10,interval=0.1"])).toThrow(
      "20 frames",
    );
    expect(() => parseTerminalVisualView(["sequence:region=0,0,1,1"])).toThrow("terminal sequence");
  });
});
