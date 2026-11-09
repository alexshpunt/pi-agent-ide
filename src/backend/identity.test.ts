import { expect, test } from "vitest";

import { remoteLocation, resolveRemoteLocation } from "./identity.ts";

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

const windows = (target: string) => (target === "win" ? ("windows" as const) : undefined);

test("Windows drive paths in any common spelling name one remote file", () => {
  const expected = remoteLocation("win", "/C:/Users/me/a b.txt");
  for (const spelling of [
    "C:\\Users\\me\\a b.txt",
    "c:/Users/me/a b.txt",
    // oxlint-disable-next-line repo/no-parent-paths -- normalization input, not a traversal
    "/C:/Users/me/./x/../a b.txt",
  ])
    expect(remoteLocation("win", spelling, "windows")).toEqual(expected);
  expect(expected.source).toBe("ssh://win/C:/Users/me/a%20b.txt");
  expect(resolveRemoteLocation(expected.source, undefined, windows)).toEqual(expected);
  // oxlint-disable-next-line repo/no-parent-paths -- checks that traversal stops at the drive
  expect(remoteLocation("win", "C:/..", "windows").path).toBe("/C:/");
});

test("paths relative to a Windows workspace follow Windows rules on the target", () => {
  const cwd = "ssh://win/C:/work";
  const resolve = (source: string) => resolveRemoteLocation(source, cwd, windows)?.path;
  expect(resolve("src\\main.ts")).toBe("/C:/work/src/main.ts");
  // oxlint-disable-next-line repo/no-parent-paths -- checks that traversal stops at the drive
  expect(resolve("..\\..\\..\\outside.txt")).toBe("/C:/outside.txt");
  expect(resolve("D:\\data\\file.txt")).toBe("/D:/data/file.txt");
  expect(resolve("\\rooted.txt")).toBe("/C:/rooted.txt");
  expect(resolveRemoteLocation("https://example.com/file", cwd, windows)).toBeUndefined();
  for (const source of ["\\\\server\\share\\file", "C:relative.txt"])
    expect(() => resolveRemoteLocation(source, cwd, windows)).toThrow(TypeError);
});

test("Windows path forms do not change Linux target identities", () => {
  expect(resolveRemoteLocation("C:/file", "ssh://one/work")).toBeUndefined();
  expect(remoteLocation("one", "/C:/file").path).toBe("/C:/file");
  expect(() => remoteLocation("one", "C:/file")).toThrow(TypeError);
});
