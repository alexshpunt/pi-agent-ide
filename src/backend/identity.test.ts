import { expect, test } from "vitest";

import { remoteLocation, resolveRemoteLocation } from "./identity.js";

test("remote file identity keeps the target and round-trips reserved filename characters", () => {
  const file = remoteLocation("one", "/work/a #b?é.txt");
  expect(file.source).toBe("ssh://one/work/a%20%23b%3F%C3%A9.txt");
  expect(resolveRemoteLocation(file.source)).toEqual(file);
  expect(remoteLocation("two", file.path).source).not.toBe(file.source);
});

test("relative remote paths resolve on the target, not the local host", () => {
  expect(resolveRemoteLocation("note.txt", "ssh://one/work/project")).toEqual(
    remoteLocation("one", "/work/project/note.txt"),
  );
  expect(resolveRemoteLocation("/outside/note.txt", "ssh://one/work/project")).toEqual(
    remoteLocation("one", "/outside/note.txt"),
  );
  expect(resolveRemoteLocation("note.txt", "/local/project")).toBeUndefined();
});

test("credentials, ports, fragments and malformed URI paths cannot become remote identities", () => {
  for (const source of [
    "ssh://user:secret@one/work/file",
    "ssh://one:22/work/file",
    "ssh://one/work/file#selection",
    "ssh://one/work/file?query",
    "ssh://one/work/%00file",
    "ssh://one/work/%GGfile",
    "ssh:relative",
  ])
    expect(() => resolveRemoteLocation(source)).toThrow(/SSH|Remote|URI|URL/u);
});
