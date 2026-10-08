import { expect, test } from "vitest";
import type { SearchEnvironment, SearchSelectionRegistration } from "pi-agent-search/api/search";
import { createAstSearchResolver } from "#src/search-resolver.js";

test("structural search keeps its executor, snapshots and presentation on the resource owner", async () => {
  const source = "ssh://fixture/work/note.ts";
  const content = 'const label = "café"; console.log(label);\n';
  const text = "console.log(label)";
  const start = Buffer.byteLength(content.slice(0, content.indexOf(text)));
  const calls: string[] = [];
  const environment: SearchEnvironment & {
    execute(
      command: string,
      args: readonly string[],
      cwd: string,
    ): Promise<{ stdout: string; stderr: string; code: number }>;
  } = {
    resolve: (_cwd, value) => (value.startsWith("ssh://") ? value : source),
    dirname: () => "ssh://fixture/work",
    basename: () => "note.ts",
    isDirectory: async () => false,
    readText: async (value) => {
      calls.push(value);
      return content;
    },
    runLines: async () => {
      throw new Error("Must not run ripgrep for structural search");
    },
    execute: async (command, args, cwd) => {
      calls.push(command, cwd);
      expect(args.at(-1)).toBe("./note.ts");
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            text,
            file: "note.ts",
            lines: content.trim(),
            language: "TypeScript",
            range: {
              byteOffset: { start, end: start + Buffer.byteLength(text) },
              start: { line: 0, column: start },
              end: { line: 0, column: start + Buffer.byteLength(text) },
            },
          },
        ]),
      };
    },
  };
  let selection: SearchSelectionRegistration | undefined;
  const resolver = createAstSearchResolver(async (value) => {
    selection = value;
    return { id: "AST1", matches: value.matches, complete: value.complete };
  });
  const context = { cwd: "/unused-local-workspace", environment };
  const result = await resolver.tryResolve(
    { query: "ast:console.log($VALUE)", path: source },
    context,
  );
  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved") throw new Error("Expected structural matches");
  expect(selection?.matches).toMatchObject([
    { source, lineNumber: 1, startColumn: 22, endColumn: 22 + text.length },
  ]);
  const formatted = await resolver.format(result.payload, context);
  expect(
    formatted.content.some((block) => block.type === "text" && block.text.includes(source)),
  ).toBe(true);
  expect(formatted.details).toMatchObject({
    files: [
      { path: source, link: source, lines: [{ ranges: [{ from: 22, to: 22 + text.length }] }] },
    ],
  });
  expect(calls).toEqual(["ast-grep", "ssh://fixture/work", source]);
  await selection?.refresh();
  expect(calls.slice(3)).toEqual(["ast-grep", "ssh://fixture/work", source]);
  environment.readText = async () => content.replace("console.log", "console.bad");
  await expect(selection?.refresh()).rejects.toThrow("AST range does not match");
  const { execute: _execute, ...withoutExecution } = environment;
  await expect(
    resolver.tryResolve(
      { query: "ast:console.log($VALUE)", path: source },
      { ...context, environment: withoutExecution },
    ),
  ).rejects.toThrow("does not support structural search execution");
  await expect(
    resolver.tryResolve({ query: "ast:console.log($VALUE)", path: source }, { cwd: context.cwd }),
  ).rejects.toThrow("No structural search owner");
});
