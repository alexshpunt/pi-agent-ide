import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { mergeUnreadablePaths, resolveRipgrepExecutable, RipgrepStderr } from "#src/ripgrep.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

test.each([
  ["linux", "rg"],
  ["win32", "rg.exe"],
] as const)("resolves Pi's bundled ripgrep binary on %s", async (platform, executableName) => {
  const agentDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-agent-ripgrep-"));
  temporaryDirectories.push(agentDirectory);
  const executable = path.join(agentDirectory, "bin", executableName);
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture", "utf8");

  expect(resolveRipgrepExecutable(agentDirectory, platform)).toBe(executable);
});

test("falls back to the system PATH when Pi has no bundled binary", async () => {
  const agentDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-agent-ripgrep-"));
  temporaryDirectories.push(agentDirectory);

  expect(resolveRipgrepExecutable(agentDirectory, "win32")).toBe("rg");
});

test("exit code 2 with per-path read errors and warnings is a finished search with unreadable paths", () => {
  const stderr = new RipgrepStderr((printed) => `/repo/${printed}`);
  // A line split across chunks and Windows line endings, as ripgrep's stderr can arrive.
  stderr.write("rg: ./.ignore: line 1: error parsing glob 'a{b': unclosed alternate group\r\n");
  stderr.write("rg: node_modules/a: The system cannot find the path");
  stderr.write(" specified. (os error 3)\r\nrg: node_modules/b: Permission denied (os error 13)");
  expect(stderr.failed(2)).toBe(false);
  expect(stderr.unreadable(2)).toEqual({
    count: 2,
    first: {
      path: "/repo/node_modules/a",
      error: "The system cannot find the path specified. (os error 3)",
    },
  });
});

const matchLimit = "rg: ./b: PCRE2: error matching: match limit exceeded";
const regexParseError = "rg: regex parse error:\n    (?:a()\n    ^\nerror: unclosed group";

test.each([
  ["a regex that does not parse", `${regexParseError}\n`, regexParseError],
  [
    "a PCRE2 match limit next to read errors",
    `rg: ./a: Permission denied (os error 13)\n${matchLimit}\n`,
    matchLimit,
  ],
  [
    "a PCRE2 match limit after more read errors than the stderr bound",
    `${"rg: ./node_modules/pkg: The system cannot find the path specified. (os error 3)\n".repeat(2000)}${matchLimit}\n`,
    matchLimit,
  ],
])(
  "exit code 2 with %s stays a failure with ripgrep's cause as its message",
  (_case, text, cause) => {
    const stderr = new RipgrepStderr();
    stderr.write(text);
    expect(stderr.failed(2)).toBe(true);
    expect(stderr.unreadable(2)).toBeUndefined();
    expect(stderr.message).toBe(cause);
  },
);

test("a run that failed with read errors alone keeps them as its message", () => {
  const stderr = new RipgrepStderr();
  stderr.write("rg: ./a: Permission denied (os error 13)\n");
  expect(stderr.failed(null)).toBe(true);
  expect(stderr.message).toBe("rg: ./a: Permission denied (os error 13)");
});

test("successful exit codes are never failures and report no unreadable paths", () => {
  const stderr = new RipgrepStderr();
  stderr.write("rg: ./.ignore: line 1: error parsing glob\n");
  expect([stderr.failed(0), stderr.failed(1)]).toEqual([false, false]);
  expect(stderr.unreadable(1)).toBeUndefined();
});

test("unreadable paths of separate scopes add up and keep the first report", () => {
  const first = { path: "/a/x", error: "Permission denied (os error 13)" };
  expect(
    mergeUnreadablePaths(
      { count: 2, first },
      { count: 3, first: { path: "/b/y", error: "Permission denied (os error 13)" } },
    ),
  ).toEqual({ count: 5, first });
  expect(mergeUnreadablePaths(undefined, { count: 1, first })).toEqual({ count: 1, first });
});
