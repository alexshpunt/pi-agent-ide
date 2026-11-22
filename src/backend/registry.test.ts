import { expect, test } from "vitest";

import { SshBackendRegistry } from "./registry.ts";

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

test("a Windows target resolves drive paths with its own rules", () => {
  const registry = new SshBackendRegistry([
    { id: "win", host: "deliberately-unreachable-win", workspace: "C:\\work", os: "windows" },
    { id: "linux", host: "deliberately-unreachable-linux", workspace: "/work" },
  ]);
  expect(registry.resolve("src\\file.ts", "ssh://win/C:/work")?.location.path).toBe(
    "/C:/work/src/file.ts",
  );
  expect(registry.resolve("ssh://win/c:/Work/file")?.location.source).toBe(
    "ssh://win/C:/Work/file",
  );
  expect(() => registry.resolve("ssh://win/work/file")).toThrow(TypeError);
  expect(registry.resolve("ssh://linux/work/file")?.location.path).toBe("/work/file");
});
