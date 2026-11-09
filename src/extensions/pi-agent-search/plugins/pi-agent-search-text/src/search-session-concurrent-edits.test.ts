import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, onTestFinished, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";

import { SearchSessionStore, type TextSearchMatch } from "#src/search-session.ts";

// Another session edits the file between the agent's Search and its edit.
const total = 250;
const original = Array.from(
  { length: total },
  (_, index) => `  result_${index} = rename_me(arg_${index}) + other(arg_${index});`,
);

async function fixture(limit: number) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-concurrent-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "main.cpp");
  await writeFile(source, `${original.join("\n")}\n`);
  const targets = new ResultTargetStore();
  const sessions = new SearchSessionStore(undefined, targets);
  const matches: TextSearchMatch[] = original.map((lineText, index) => {
    const startColumn = lineText.indexOf("rename_me");
    return {
      source,
      lineNumber: index + 1,
      startColumn,
      endColumn: startColumn + "rename_me".length,
      matchedText: "rename_me",
      lineText,
    };
  });
  const session = await sessions.register("rename_me", matches, matches.length <= limit, cwd);
  const resolve = async (reference: string) => {
    const attempt = await sessions.resourceResolver().tryResolve(reference, { cwd });
    return attempt;
  };
  return { cwd, source, sessions, session, resolve };
}

function rangesOf(attempt: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["resolve"]>>) {
  if (attempt.kind !== "resolved") throw new Error(JSON.stringify(attempt));
  return attempt.targets.flatMap((target) => target.ranges ?? []);
}

test("every numbered reference behaves the same, whatever its number", async () => {
  const { source, session, resolve } = await fixture(50);
  // Shift every line and change another part of every second line, as concurrent renames do.
  const edited = original.map((line, index) =>
    index % 2 === 0 ? line.replace("other(", "different(") : line,
  );
  await writeFile(source, `// new first line\n${edited.join("\n")}\n`);
  for (const number of [1, 50, 101, 150, 250]) {
    for (const mode of ["match", "line"] as const) {
      const attempt = await resolve(`SEARCH#${session.id}:${number}:${mode}`);
      if (mode === "line") {
        // A whole-line selection follows an unchanged line and is retired with a changed one.
        expect(attempt.kind).toBe((number - 1) % 2 === 0 ? "rejected" : "resolved");
        continue;
      }
      const [range] = rangesOf(attempt);
      expect(range?.start.lineNumber).toBe(number + 1);
      expect(range?.start.column).toBe(original[number - 1]?.indexOf("rename_me"));
    }
  }
});

test("a reference from a limited search is complete for its own match", async () => {
  const { session, resolve } = await fixture(50);
  expect(session.complete).toBe(false);
  expect(rangesOf(await resolve(`SEARCH#${session.id}:120:match`))).toHaveLength(1);
  const all = await resolve(`SEARCH#${session.id}:all:match`);
  expect(all.kind).toBe("rejected");
});

test("a match whose own text changed is rejected with its current line", async () => {
  const { source, session, resolve } = await fixture(500);
  const edited = [...original];
  edited[119] = edited[119]?.replace("rename_me", "renamed_already") ?? "";
  await writeFile(source, `${edited.join("\n")}\n`);
  const attempt = await resolve(`SEARCH#${session.id}:120:match`);
  expect(attempt.kind).toBe("rejected");
  if (attempt.kind !== "rejected") return;
  expect(attempt.rejection.reason).toContain("line 120");
  expect(attempt.rejection.reason).toContain("120| result_119 = renamed_already(arg_119)");
  // Its neighbours are unaffected.
  expect(rangesOf(await resolve(`SEARCH#${session.id}:121:match`))).toHaveLength(1);
});

test("the anchor resolver follows a match to its new position in the current text", async () => {
  const { source, sessions, session } = await fixture(500);
  const edited = original.map((line) => line.replace("arg_5)", "argument_5)"));
  const content = `top\n${edited.join("\n")}\n`;
  await writeFile(source, content);
  const attempt = await sessions.anchorResolver().tryResolve(`SEARCH#${session.id}:6:match`, {
    source,
    content: await readFile(source, "utf8"),
    lines: content.split("\n"),
    cwd: path.dirname(source),
  });
  expect(attempt.kind).toBe("resolved");
  if (attempt.kind !== "resolved") return;
  expect(attempt.anchor.lineNumber).toBe(7);
});
