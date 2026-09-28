import { describe, expect, it } from "vitest";

import { isBerlinMidnight } from "./nightly-schedule.ts";

describe("Berlin nightly schedule", () => {
  it("uses 23:00 UTC in winter", () => {
    expect(isBerlinMidnight(new Date("2026-01-15T23:00:00Z"))).toBe(true);
    expect(isBerlinMidnight(new Date("2026-01-15T22:00:00Z"))).toBe(false);
  });

  it("uses 22:00 UTC in summer", () => {
    expect(isBerlinMidnight(new Date("2026-07-15T22:00:00Z"))).toBe(true);
    expect(isBerlinMidnight(new Date("2026-07-15T23:00:00Z"))).toBe(false);
  });

  it("switches at both daylight-saving boundaries", () => {
    expect(isBerlinMidnight(new Date("2026-03-29T22:00:00Z"))).toBe(true);
    expect(isBerlinMidnight(new Date("2026-10-25T23:00:00Z"))).toBe(true);
  });
});
