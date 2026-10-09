import { expect, test } from "vitest";

import { SshBackendRegistry } from "./registry.js";

test("only configured targets resolve, without contacting hosts", () => {
  const registry = new SshBackendRegistry([
    { id: "one", host: "deliberately-unreachable-one", workspace: "/work" },
    { id: "two", host: "deliberately-unreachable-two", workspace: "/work" },
  ]);
  expect(registry.resolve("ssh://one/work/file")?.location.target).toBe("one");
  expect(registry.resolve("ssh://two/work/file")?.location.target).toBe("two");
  expect(registry.resolve("file", "ssh://one/work")?.location.path).toBe("/work/file");
  expect(registry.resolve("file", "/local/work")).toBeUndefined();
  expect(() => registry.resolve("ssh://unknown/work/file")).toThrow("UNKNOWN_TARGET");
});

test("ambiguous duplicate target IDs fail configuration instead of selecting one silently", () => {
  expect(
    () =>
      new SshBackendRegistry([
        { id: "one", host: "first", workspace: "/work" },
        { id: "one", host: "second", workspace: "/elsewhere" },
      ]),
  ).toThrow("Duplicate SSH target");
});
