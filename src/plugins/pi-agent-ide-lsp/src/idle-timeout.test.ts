import { expect, test } from "vitest";

import { lspIdleTimeoutMs } from "./idle-timeout.js";

test.each([
  ["", 600_000],
  ["10", 600_000],
  ["2.5", 150_000],
  [" 30 ", 1_800_000],
])("reads idle timeout %j in minutes", (value, expected) => {
  expect(lspIdleTimeoutMs(value)).toBe(expected);
});

test.each(["0", "-1", "ten", "Infinity", "1e400"])("rejects idle timeout %j", (value) => {
  expect(() => lspIdleTimeoutMs(value)).toThrow(/lsp\.idle-timeout/u);
});
