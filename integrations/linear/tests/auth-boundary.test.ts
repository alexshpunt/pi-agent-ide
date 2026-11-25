import { required } from "./fixtures/check.ts";
import { expect, test, vi } from "vitest";
import { createTextDocument } from "pi-agent-ide/api/text";
import {
  ResultTargetStore,
  type AgentContent,
  type Resource,
  type ResourceResolver,
} from "pi-agent-ide/api/resource";
import type { ReadPipelineContext, ReadTextState, ReadToolResult } from "pi-agent-ide/api/read";
import { createLinearAuthBoundary, currentLinearAuthEpoch } from "#linear/auth-boundary.ts";

test("parallel operations keep the selected profile with their own auth epoch", async () => {
  const { currentLinearConnectionId } = await import("#linear/auth-boundary.ts");
  const a = createLinearAuthBoundary({
    readEpoch: async () => ({ epoch: "A", state: "connected", connectionId: "profile-a" }),
    onChange: () => {},
  });
  const b = createLinearAuthBoundary({
    readEpoch: async () => ({ epoch: "B", state: "connected", connectionId: "profile-b" }),
    onChange: () => {},
  });
  const seen = await Promise.all(
    [a, b].map((boundary) =>
      boundary.run("/fixture", undefined, async () => {
        const before = currentLinearConnectionId();
        await Promise.resolve();
        expect(currentLinearConnectionId()).toBe(before);
        return [currentLinearAuthEpoch(), before];
      }),
    ),
  );
  expect(seen).toEqual([
    ["A", "profile-a"],
    ["B", "profile-b"],
  ]);
  expect(currentLinearConnectionId()).toBeUndefined();
});
const cwd = "/fixture";
const source = "linear://example/document/11111111-1111-4111-8111-111111111111/content";
const original = "Alpha\nBeta\n";
function setup(targets?: ResultTargetStore) {
  let epoch = "A";
  let state = "connected";
  const onChange = vi.fn();
  const boundary = createLinearAuthBoundary({
    readEpoch: async () => ({ epoch, state }),
    onChange,
    targets,
  });
  return {
    boundary,
    onChange,
    setEpoch: (value: string) => {
      epoch = value;
    },
    setState: (value: string) => {
      state = value;
    },
  };
}
async function resource(
  boundary: ReturnType<typeof createLinearAuthBoundary>,
  write = vi.fn(async () => {}),
  read = async (): Promise<AgentContent> => [{ type: "text", text: original }],
) {
  const inner: ResourceResolver = {
    id: "fixture",
    async tryResolve() {
      return {
        kind: "resolved",
        resource: { source, sourceBytes: Buffer.from(original), read, write },
      };
    },
  };
  const resolved = await boundary.resolver(inner).tryResolve(source, { cwd });
  if (resolved.kind !== "resolved") throw new Error("fixture did not resolve");
  return { value: resolved.resource, write };
}
function textBlocks(blocks: AgentContent): ReadTextState["content"] {
  const first = blocks.at(0);
  if (first?.type !== "text" || blocks.length !== 1) throw new Error("Expected one text block");
  // Keep the original acquisition object: its identity binds the authority.
  return blocks as ReadTextState["content"];
}
async function observe(
  boundary: ReturnType<typeof createLinearAuthBoundary>,
  value: Resource,
  first = 1,
  last = 2,
  target?: string,
  sourceTarget?: string,
) {
  const blocks = await required(value.read)({});
  const document = createTextDocument(source, original);
  const context: ReadPipelineContext = {
    request: { path: source },
    resolverContext: { cwd },
    ...(sourceTarget ? { sourceTarget } : {}),
    sourceText: original,
    state: {
      source,
      resolvedBy: "fixture",
      preserveTruncatedOutput: false,
      textMode: "normal",
      contentKind: "text",
      content: textBlocks(blocks),
      text: document,
    },
  };
  const result: ReadToolResult = {
    content: [{ type: "text", text: original }],
    details: { source },
    script: {
      kind: "text",
      source,
      content: original,
      lines: document.lines.slice(first - 1, last),
      startLine: first,
      endLine: last,
      totalLines: document.lines.length,
      ...(target ? { target } : {}),
    },
  };
  const outcome = await boundary.postRead(context);
  if (outcome.kind !== "continue") throw new Error("fixture observation failed");
  return outcome.transform?.(result) ?? result;
}

test("a resolved resource cannot read or write under a replacement account even when text is unchanged", async () => {
  const f = setup();
  const a = await resource(f.boundary);
  await observe(f.boundary, a.value);
  f.setEpoch("B");
  await expect(
    required(a.value.write)([{ type: "text", text: "Changed\nBeta\n" }], {}),
  ).rejects.toThrow("LINEAR_AUTH_CHANGED");
  await expect(required(a.value.read)({})).rejects.toThrow("LINEAR_AUTH_CHANGED");
  expect(a.write).not.toHaveBeenCalled();
  expect(f.onChange).toHaveBeenCalledWith(cwd, [source]);
});

test("a late read from the previous account never becomes a successful acquisition", async () => {
  const f = setup();
  let finish!: (value: AgentContent) => void;
  const delayed = new Promise<AgentContent>((resolve) => {
    finish = resolve;
  });
  const a = await resource(f.boundary, undefined, () => delayed);
  const reading = required(a.value.read)({});
  await Promise.resolve();
  f.setEpoch("B");
  await f.boundary.run(cwd, undefined, async () => {});
  finish([{ type: "text", text: original }]);
  await expect(reading).rejects.toThrow("LINEAR_AUTH_CHANGED");
});

test("a resource write needs no prior read", async () => {
  const f = setup();
  const a = await resource(f.boundary);
  await required(a.value.write)([{ type: "text", text: "Changed\nBeta\n" }], {});
  expect(a.write).toHaveBeenCalledTimes(1);
});
test("one operation keeps its epoch across await and refuses nested calls after a switch", async () => {
  const f = setup();
  let finish!: () => void;
  const delay = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const a = f.boundary.run(cwd, undefined, async () => {
    expect(currentLinearAuthEpoch()).toBe("A");
    await delay;
    expect(currentLinearAuthEpoch()).toBe("A");
    await expect(f.boundary.run(cwd, undefined, async () => "must not run")).rejects.toThrow(
      "LINEAR_AUTH_CHANGED",
    );
    return currentLinearAuthEpoch();
  });
  await Promise.resolve();
  f.setEpoch("B");
  expect(await f.boundary.run(cwd, undefined, async () => currentLinearAuthEpoch())).toBe("B");
  finish();
  expect(await a).toBe("A");
  expect(currentLinearAuthEpoch()).toBeUndefined();
});

test("auth changes retire only known Linear result handles and guard retained readCurrent callbacks", async () => {
  const targets = new ResultTargetStore();
  const f = setup(targets);
  const a = await resource(f.boundary);
  const range = { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 3, column: 0 } };
  const initial = targets.register(
    [{ source, expectedContent: original, ranges: [range], readCurrent: async () => original }],
    cwd,
    true,
  );
  const other = targets.register(
    [
      {
        source: "https://other.example/text",
        expectedContent: "other",
        ranges: [range],
        readCurrent: async () => "other",
      },
    ],
    cwd,
    true,
  );
  const output = await observe(f.boundary, a.value, 1, 2, initial);
  if (output.script?.kind !== "text" || !output.script.target) throw new Error("no target");
  const target = output.script.target;
  const guarded = required(targets.resolve(target, cwd).targets[0]);
  f.setEpoch("B");
  await f.boundary.run(cwd, undefined, async () => {});
  expect(() => targets.resolve(initial, cwd)).toThrow(/expired/i);
  expect(() => targets.resolve(target, cwd)).toThrow(/RESULT#/u);
  expect(targets.resolve(other, cwd).targets).toHaveLength(1);
  await expect(required(guarded.readCurrent)()).rejects.toThrow("LINEAR_AUTH_CHANGED");
});

test("semantic writes need no prior read of the resource", async () => {
  const f = setup();
  const execute = vi.fn(async () => ({
    source: "linear://example/issue/ENG-12",
    summary: "Created",
    data: { created: true },
  }));
  const handler = f.boundary.semantic({ matches: () => true, execute });
  await handler.execute(
    { cwd, sourceDocument: { content: "" } },
    { path: "linear://example/issue/new", content: "{}" },
  );
  await handler.execute(
    { cwd, sourceDocument: { content: "" } },
    { path: "linear://example/diff/a#merge", content: "{}" },
  );
  await handler.execute(
    { cwd, sourceDocument: { content: "" } },
    { path: "linear://example/issue/ENG-12#fields", content: '{"priority":3}' },
  );
  await handler.execute(
    { cwd, sourceDocument: { content: "2" } },
    { path: "linear://example/issue/ENG-12#priority", content: "3" },
  );
  await handler.execute(
    { cwd, sourceDocument: { content: original } },
    { path: source, content: "Changed\nBeta\n" },
  );
  expect(execute).toHaveBeenCalledTimes(5);
});

test("owned file actions are pinned and a signed-out connection cannot dispatch them", async () => {
  const f = setup();
  const execute = vi.fn(async () => {
    expect(currentLinearAuthEpoch()).toBe("A");
    return undefined;
  });
  await f.boundary.fileOperations(execute)(
    "delete",
    { path: "linear://example/comment/a" },
    { cwd },
  );
  f.setEpoch("B");
  f.setState("signed-out");
  await expect(
    f.boundary.fileOperations(execute)("delete", { path: "linear://example/comment/a" }, { cwd }),
  ).rejects.toThrow("LINEAR_AUTH_REQUIRED");
  expect(execute).toHaveBeenCalledTimes(1);
});

test("a post-read acquisition remains bound to its account even after a newer identical read", async () => {
  const f = setup();
  const a = await resource(f.boundary);
  const aContent = await required(a.value.read)({});
  f.setEpoch("B");
  const b = await resource(f.boundary);
  await observe(f.boundary, b.value);
  const context: ReadPipelineContext = {
    request: { path: source },
    resolverContext: { cwd },
    sourceText: original,
    state: {
      source,
      resolvedBy: "fixture",
      preserveTruncatedOutput: false,
      textMode: "normal",
      contentKind: "text",
      content: textBlocks(aContent),
      text: createTextDocument(source, original),
    },
  };
  await expect(f.boundary.postRead(context)).rejects.toThrow("LINEAR_AUTH_CHANGED");
});
