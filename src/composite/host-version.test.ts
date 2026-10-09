import { expect, test } from "vitest";
import { assertSupportedHost } from "./host-version.js";

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
