import { expect, test, vi } from "vitest";
import {
  clangCoverage,
  coverageNotes,
  createClangReach,
  MAX_OPENED_FILES,
  mergeCoverage,
  renameRefusal,
  type ClangCoverage,
  type ReachClient,
  type ReachManager,
} from "./clang-coverage.ts";
import type { DocumentErrors, DocumentErrorsProvider } from "./corrected-names.ts";

const NO_ERRORS: DocumentErrors = { starts: new Set(), stopped: false, fatal: [] };

/** A clangd client whose open documents are tracked, and a manager that lists `files`. */
function fixture(files: readonly string[] | undefined, open: readonly string[] = []) {
  const opened = new Set(open.map((file) => `file://${file}`));
  const client: ReachClient = {
    serverId: "clangd",
    rootUri: "file:///workspace",
    toUri: (source: string) => `file://${source}`,
    documentContent: (uri: string) => (opened.has(uri) ? "text" : undefined),
  };
  const filesContaining = vi.fn<ReachManager["filesContaining"]>(async () => files);
  const openFile = vi.fn<ReachManager["openFile"]>(async (source) => {
    opened.add(`file://${source}`);
    return { client };
  });
  const manager: ReachManager = { filesContaining, openFile };
  const errorsOf = vi.fn<DocumentErrorsProvider>(async () => NO_ERRORS);
  return { client, manager, filesContaining, openFile, errorsOf };
}

test("other languages open nothing", async () => {
  const { client, manager, filesContaining, errorsOf } = fixture(["/workspace/a.ts"]);
  const reach = createClangReach({ manager, cwd: "/workspace", errorsOf });
  expect(await reach(client, "typescript", "count")).toBeUndefined();
  expect(filesContaining).not.toHaveBeenCalled();
});

test("files that contain the name are opened and parsed before the query", async () => {
  const { client, manager, filesContaining, openFile, errorsOf } = fixture(
    ["/workspace/b.cpp", "/workspace/a.cpp", "/workspace/lib.h"],
    ["/workspace/lib.h"],
  );
  const reach = createClangReach({ manager, cwd: "/workspace", errorsOf });
  const result = await reach(client, "cpp", "~call_normalize_routine");
  expect(filesContaining).toHaveBeenCalledWith(
    client,
    "call_normalize_routine",
    expect.any(Set),
    undefined,
  );
  expect(openFile.mock.calls.map(([source]) => source)).toEqual([
    "/workspace/a.cpp",
    "/workspace/b.cpp",
  ]);
  expect(result).toMatchObject({
    opened: ["file:///workspace/a.cpp", "file:///workspace/b.cpp", "file:///workspace/lib.h"],
    unopened: 0,
    unlisted: false,
  });
  expect(errorsOf).toHaveBeenCalledTimes(3);
});

test("one operation opens a limited number of files for all its names and looks up each once", async () => {
  const files = Array.from(
    { length: MAX_OPENED_FILES + 3 },
    (_, index) => `/workspace/f${String(index).padStart(2, "0")}.cpp`,
  );
  const { client, manager, filesContaining, openFile, errorsOf } = fixture(files);
  const reach = createClangReach({ manager, cwd: "/workspace", errorsOf });
  expect((await reach(client, "cpp", "first"))?.unopened).toBe(3);
  expect(openFile).toHaveBeenCalledTimes(MAX_OPENED_FILES);
  // The budget is spent; files opened for the first name are already open for the second.
  expect((await reach(client, "cpp", "second"))?.unopened).toBe(3);
  expect(openFile).toHaveBeenCalledTimes(MAX_OPENED_FILES);
  await reach(client, "cpp", "first");
  expect(filesContaining).toHaveBeenCalledTimes(2);
});

test("files outside the accepted scope are not opened", async () => {
  const { client, manager, openFile, errorsOf } = fixture(["/workspace/a.cpp", "/other/b.cpp"]);
  const reach = createClangReach({
    manager,
    cwd: "/workspace",
    errorsOf,
    accepts: (source) => source.startsWith("/workspace/"),
  });
  expect((await reach(client, "cpp", "name"))?.opened).toEqual(["file:///workspace/a.cpp"]);
  expect(openFile).toHaveBeenCalledTimes(1);
});

test("an owner without a text search reports that files could not be listed", async () => {
  const { client, manager, errorsOf } = fixture(undefined);
  const reach = await createClangReach({ manager, cwd: "/workspace", errorsOf })(
    client,
    "c",
    "name",
  );
  expect(reach).toMatchObject({ opened: [], unlisted: true });
  expect(coverageNotes(await clangCoverage(reach!, [], errorsOf, (uri) => uri), String)).toEqual([
    expect.stringContaining("could not be listed"),
  ]);
});

test("coverage names fatal errors of open files and counts files without diagnostics", async () => {
  const { client, errorsOf } = fixture([], ["/workspace/a.cpp", "/workspace/b.cpp"]);
  errorsOf.mockImplementation(async (uri) =>
    uri.endsWith("a.cpp")
      ? { ...NO_ERRORS, fatal: [{ line: 2, message: "'x.h' file not found" }] }
      : undefined,
  );
  const coverage = await clangCoverage(
    { client, opened: ["file:///workspace/b.cpp"], unopened: 1, unlisted: false },
    ["file:///workspace/a.cpp", "file:///workspace/unopened.cpp"],
    errorsOf,
    (uri) => uri.slice("file://".length),
  );
  expect(coverage).toEqual({
    fatal: [{ source: "/workspace/a.cpp", line: 2, message: "'x.h' file not found" }],
    unchecked: 2,
    unlisted: false,
  });
  expect(errorsOf).not.toHaveBeenCalledWith("file:///workspace/unopened.cpp");
});

test("notes and rename refusals say what can be missing", () => {
  const coverage: ClangCoverage = {
    fatal: [{ source: "/workspace/a.cpp", line: 2, message: "'x.h' file not found" }],
    unchecked: 3,
    unlisted: false,
  };
  const display = (source: string) => source.slice("/workspace/".length);
  const notes = coverageNotes(coverage, display);
  expect(notes).toHaveLength(2);
  expect(notes[0]).toContain("a.cpp:2 'x.h' file not found");
  expect(notes[0]).toContain("Read diagnostics:a.cpp");
  expect(notes[1]).toContain("3 more file(s)");
  const refusal = renameRefusal(coverage, display);
  expect(refusal).toMatch(/^LSP rename refused; no edits applied\./u);
  expect(refusal).toContain("a.cpp:2 'x.h' file not found");
  expect(refusal).toContain("3 more file(s)");
  expect(renameRefusal({ fatal: [], unchecked: 0, unlisted: false }, display)).toBeUndefined();
  expect(renameRefusal(undefined, display)).toBeUndefined();
});

test("merged coverage keeps each fatal error once", () => {
  const error = { source: "/workspace/a.cpp", line: 2, message: "'x.h' file not found" };
  expect(
    mergeCoverage([
      { fatal: [error], unchecked: 1, unlisted: false },
      undefined,
      { fatal: [error], unchecked: 2, unlisted: true },
    ]),
  ).toEqual({ fatal: [error], unchecked: 2, unlisted: true });
  expect(mergeCoverage([undefined])).toBeUndefined();
});
