import { expect, test } from "vitest";
import { assertSupportedHost, hostOwnsToolLoadout } from "./host-version.js";

// Older hosts must fail clearly before IDE modules can call unavailable APIs.
test.each(["0.84.2", "0.99.0", "0.99.1-beta.1", "unknown"])(
  "rejects unsupported Pi %s with an upgrade message",
  (version) => {
    expect(() => assertSupportedHost(version)).toThrow(/0\.99\.1/u);
  },
);

test.each(["0.99.1", "0.99.1+build.1", "0.99.2", "0.100.0", "1.0.0"])(
  "accepts Pi %s",
  (version) => {
    expect(() => assertSupportedHost(version)).not.toThrow();
  },
);

// Older hosts still need the IDE to restore discovered tools; newer hosts do it themselves.
test.each([
  ["0.99.1", false],
  ["1.2.9", false],
  ["1.3.0-beta.1", false],
  ["1.3.0", true],
  ["1.3.1+build.2", true],
  ["2.0.0", true],
  ["unknown", false],
])("Pi %s owns the resumed tool loadout: %s", (version, owns) => {
  expect(hostOwnsToolLoadout(version)).toBe(owns);
});
