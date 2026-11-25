import { expect, test, vi } from "vitest";
import { createTextDocument, renderPresentedTextDocument } from "pi-agent-ide/api/text";
import type { AgentContent, ResourceResolver } from "pi-agent-ide/api/resource";
import type { ReadPipelineContext, ReadToolResult } from "pi-agent-ide/api/read";
import {
  captureLinearJson,
  linearApiPageCoverage,
  linearJsonContent,
  linearJsonCoverage,
  linearJsonRead,
  linearJsonSnapshot,
  withLinearJson,
} from "#linear/json-read.ts";
import { createLinearDomainResolver } from "#linear/domain-read.ts";
import { createLinearFields } from "#linear/fields.ts";
import { createLinearResolver } from "#linear/read.ts";
import { createLinearArtifactBackend } from "#linear/artifact-backend.ts";
import { createLinearArtifactResolver } from "#linear/artifact-actions.ts";
import type { LinearOperationBackend } from "#linear/operation-backend.ts";

const source = "linear://example/issue/ENG-12";
const cwd = process.cwd();
function context(content: AgentContent, path = source, views = ["jq:."]): ReadPipelineContext {
  if (content.length !== 1 || content[0].type !== "text")
    throw new Error("Expected one text acquisition");
  return {
    request: { path, views },
    resolverContext: { cwd },
    inputScope: "source",
    sourceText: content[0].text,
    state: {
      source: path,
      resolvedBy: "linear-domain",
      preserveTruncatedOutput: false,
      textMode: "normal",
      contentKind: "text",
      content: [content[0]],
      text: createTextDocument(path, content[0].text),
    },
  };
}
async function transform(input: ReadPipelineContext): Promise<ReadPipelineContext> {
  const outcome = await linearJsonRead(input);
  expect(outcome.kind).toBe("continue");
  if (outcome.kind !== "continue") throw new Error("Unexpected jq failure");
  return outcome.context;
}
async function acquire(resolver: ResourceResolver, path: string) {
  const attempt = await resolver.tryResolve(path, { cwd });
  if (attempt.kind !== "resolved" || !attempt.resource.read)
    throw new Error("Resource not readable");
  return attempt.resource.read({});
}
function textState(input: ReadPipelineContext) {
  const state = input.state;
  if (state?.contentKind !== "text") throw new Error("Expected transformed text");
  return state;
}

function parsedState(input: ReadPipelineContext): unknown {
  return JSON.parse(textState(input).text.content) as unknown;
}

function result(input: ReadPipelineContext): ReadToolResult {
  const state = textState(input);
  return {
    content: [{ type: "text", text: state.text.content }],
    details: { source: state.source, lines: state.text.lines },
    script: {
      kind: "text",
      source: state.source,
      content: state.text.content,
      lines: state.text.lines,
      startLine: 1,
      endLine: state.text.lines.length,
      totalLines: state.text.lines.length,
    },
  };
}

test("jq consumes the immutable acquisition, not its Markdown presentation or URI", async () => {
  const data = { id: "first" };
  const a = linearJsonContent(linearJsonSnapshot(data, "# Markdown, not JSON"));
  data.id = "mutated";
  const b = linearJsonContent(linearJsonSnapshot({ id: "second" }, "# Markdown, not JSON"));
  const output = await Promise.all(
    [a, b].map((blocks) => transform(context(blocks, source, ["jq:.id"]))),
  );
  expect(output.map(parsedState)).toEqual(["first", "second"]);
  for (const x of output) {
    expect(x.sourceText).toBeUndefined();
    expect(x.sourceTarget).toBeUndefined();
    expect(x.state?.preserveTruncatedOutput).toBe(true);
  }
});

test("identity jq loses provenance even when output bytes equal the ordinary acquisition", async () => {
  const blocks = linearJsonContent(linearJsonSnapshot(3, "3\n"));
  const input = context(blocks);
  const transformed = await transform(input);
  expect(transformed.state?.text?.content).toBe(input.sourceText);
  expect(transformed.sourceText).toBeUndefined();
  expect(transformed.state?.text).not.toBe(input.state?.text);
});

test("ordinary reads retain their exact context and block identity", async () => {
  const input = context(
    linearJsonContent(linearJsonSnapshot({ id: 1 }, "ordinary text")),
    source,
    [],
  );
  expect(await transform(input)).toBe(input);
});

test.each(["jq:.", "jq:.id"])(
  "unregistered bodies cannot masquerade as acquired JSON (%s)",
  async (view) => {
    const input = context([{ type: "text", text: '{"id":"private-body"}' }], source, [view]);
    const output = await linearJsonRead(input);
    expect(output.kind).toBe("return");
    if (output.kind !== "return") throw new Error("Missing explicit unsupported-content failure");
    expect(output.result.isError).toBe(true);
    expect(output.result.details.failure?.code).toBe("UNSUPPORTED_CONTENT");
    expect(JSON.stringify(output.result)).not.toContain("private-body");
  },
);

test.each(["RESULT#fixture", "SEARCH#fixture", source + "#anchor"])(
  "bounded input cannot query complete JSON: %s",
  async (path) => {
    const input = {
      ...context(
        linearJsonContent(linearJsonSnapshot({ secret: "unseen-json" }, "visible heading")),
        path,
      ),
      inputScope: "selection" as const,
    };
    const output = await linearJsonRead(input);
    expect(output.kind).toBe("return");
    if (output.kind !== "return") throw new Error("Missing explicit range failure");
    expect(output.result.details.failure?.code).toBe("UNSUPPORTED_RANGE");
    expect(JSON.stringify(output.result)).not.toContain("unseen-json");
  },
);

test("per-invocation capture isolates concurrently finishing legacy readers", async () => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const a = captureLinearJson(async (capture) => {
    capture({ id: "a" });
    await delayed;
    return "a heading";
  });
  const b = await captureLinearJson(async (capture) => {
    capture({ id: "b" });
    return "b heading";
  });
  release();
  const output = await Promise.all(
    [await a, b].map((value) => transform(context(value, source, ["jq:.id"]))),
  );
  expect(output.map(parsedState)).toEqual(["a", "b"]);
});

test("coverage survives jq removing pagination, separately from canonical output", async () => {
  const next = "linear://example/issues?cursor=next";
  const blocks = linearJsonContent(
    withLinearJson(
      { content: "API page heading" },
      { items: [{ id: "one" }], pageInfo: { hasNextPage: true, endCursor: "next" } },
      next,
    ),
  );
  const transformed = await transform(context(blocks, source, ["jq:.items | length"]));
  const base = result(transformed);
  const decoration = await linearJsonCoverage({ ...transformed, result: base });
  if (decoration.kind !== "continue") throw new Error("Unexpected coverage result");
  const decorated = decoration.transform?.(base) ?? base;
  expect(decorated.script).toBe(base.script);
  if (decorated.script?.kind !== "text") throw new Error("Missing canonical JSON stream");
  expect(JSON.parse(decorated.script.content)).toBe(1);
  expect(decorated.content).toContainEqual({ type: "text", text: next });
  expect(decorated.content).not.toContainEqual({ type: "text", text: "API page heading" });
});

const schema = (properties: Record<string, unknown>) => ({ type: "object", properties });
function backend(data: unknown): {
  backend: LinearOperationBackend;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn(async (workspace: string, operation: string) => ({
    workspace,
    operation,
    effect: "applied" as const,
    data,
  }));
  return {
    invoke,
    backend: {
      capabilities: async () => [
        { name: "get_issue", inputSchema: schema({ id: { type: "string" } }), annotations: {} },
        {
          name: "save_issue",
          inputSchema: schema({
            id: { type: "string" },
            state: { type: "string" },
            priority: { type: "number" },
            estimate: { type: ["number", "null"] },
            labels: { type: "array", items: { type: "string" } },
          }),
          annotations: {},
        },
        {
          name: "list_issues",
          inputSchema: schema({ cursor: { type: "string" }, limit: { type: "integer" } }),
          annotations: {},
        },
      ],
      invoke,
    },
  };
}

test.each([
  ["status", "Todo"],
  ["priority", 3],
  ["estimate", null],
  ["labels", ["Bug", "Urgent"]],
] as const)("typed #%s is filtered as its native value", async (field, expected) => {
  const f = backend({
    id: "ENG-12",
    status: "Todo",
    priority: { value: 3 },
    estimate: null,
    labels: [{ name: "Bug" }, { name: "Urgent" }],
  });
  const path = source + "#" + field;
  const blocks = await acquire(createLinearFields(f.backend).resolver, path);
  const transformed = await transform(context(blocks, path));
  expect(parsedState(transformed)).toEqual(expected);
  expect(f.invoke).toHaveBeenCalledTimes(1);
});

test("domain page filters only the acquired page and keeps its continuation", async () => {
  const f = backend({
    nodes: [{ id: "one", title: "One" }],
    pageInfo: { hasNextPage: true, endCursor: "next" },
  });
  const path = "linear://example/issues";
  const blocks = await acquire(createLinearDomainResolver(f.backend), path);
  const transformed = await transform(context(blocks, path, ["jq:.nodes | length"]));
  expect(parsedState(transformed)).toBe(1);
  const base = result(transformed);
  const decoration = await linearJsonCoverage({ ...transformed, result: base });
  if (decoration.kind !== "continue") throw new Error("Unexpected decoration");
  expect(JSON.stringify(decoration.transform?.(base).content)).toContain("cursor=next");
  expect(f.invoke).toHaveBeenCalledTimes(1);
});

test("legacy issue cards register the object without reading linked resources", async () => {
  const readIssue = vi.fn(async () => ({
    id: "ENG-12",
    title: "Title",
    description: "Body",
    url: "https://linear.app/example/issue/ENG-12/title",
  }));
  const readDocument = vi.fn();
  const readPage = vi.fn();
  const path = "https://linear.app/example/issue/ENG-12/title";
  const blocks = await acquire(createLinearResolver(readIssue, readDocument, readPage), path);
  const transformed = await transform(context(blocks, path, ["jq:.id"]));
  expect(parsedState(transformed)).toBe("ENG-12");
  expect(readIssue).toHaveBeenCalledTimes(1);
  expect(readDocument).not.toHaveBeenCalled();
  expect(readPage).not.toHaveBeenCalled();
});

test("field readback replaces text and JSON together without changing an older acquisition", async () => {
  let priority = 3;
  const f = backend({});
  f.backend.invoke = vi.fn(
    async (workspace: string, operation: string, input: Readonly<Record<string, unknown>>) => {
      if (operation === "save_issue") {
        if (typeof input.priority !== "number") throw new Error("Expected numeric priority");
        priority = input.priority;
      }
      return { workspace, operation, effect: "applied" as const, data: { id: "ENG-12", priority } };
    },
  );
  const path = source + "#priority";
  const attempt = await createLinearFields(f.backend).resolver.tryResolve(path, { cwd });
  if (attempt.kind !== "resolved" || !attempt.resource.read || !attempt.resource.write)
    throw new Error("Missing readable, writable field");
  const old = await attempt.resource.read({});
  await attempt.resource.write([{ type: "text", text: "4" }], {});
  const fresh = await attempt.resource.read({});
  const [a, b] = await Promise.all([old, fresh].map((blocks) => transform(context(blocks, path))));
  expect(parsedState(a)).toBe(3);
  expect(parsedState(b)).toBe(4);
  expect(fresh).toEqual([{ type: "text", text: "4" }]);
  // The write reuses the resolved card, and the save response serves the readback.
  expect(vi.mocked(f.backend.invoke).mock.calls.map(([, operation]) => operation)).toEqual([
    "get_issue",
    "save_issue",
  ]);
});

test.each(["jq:.id", "jq:empty"])(
  "page coverage is visible in the Read panel without changing canonical output (%s)",
  async (view) => {
    const notice =
      "Only the acquired API page is covered.\nNext: linear://example/issues?cursor=next";
    const blocks = linearJsonContent(linearJsonSnapshot({ id: "one" }, "Card", notice));
    const transformed = await transform(context(blocks, source, [view]));
    const base = result(transformed);
    const decoration = await linearJsonCoverage({ ...transformed, result: base });
    if (decoration.kind !== "continue" || !decoration.transform)
      throw new Error("Missing coverage");
    const decorated = decoration.transform(base);
    const lines = decorated.details.lines;
    const visible =
      lines === undefined
        ? decorated.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n")
        : renderPresentedTextDocument(
            { source, content: "", lines: lines.slice(0, 1) },
            { compact: true },
          );
    expect(visible).toContain(notice);
    expect(decorated.script).toBe(base.script);
    expect(base.details.lines).toEqual(textState(transformed).text.lines);
    expect(base.details.lines?.every((line) => line.presentation === undefined)).toBe(true);
    if (view === "jq:empty")
      expect(decorated.script?.kind === "text" && decorated.script.content).toBe("");
    else
      expect(decorated.script?.kind === "text" && JSON.parse(decorated.script.content)).toBe("one");
  },
);

test("attachment metadata uses its structured description, never downloaded bytes", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const f = backend({ attachment: { id, title: "Report", url: "https://example.org/report.pdf" } });
  const resolver = createLinearArtifactResolver(createLinearArtifactBackend(f.backend));
  const path = "linear://example/attachment/" + id + "#file";
  const blocks = await acquire(resolver, path);
  const transformed = await transform(context(blocks, path, ["jq:.title"]));
  expect(parsedState(transformed)).toBe("Report");
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(f.invoke.mock.calls[0][1]).toBe("get_attachment");
});

test("a cloned presentation block cannot inherit another acquisition's JSON", async () => {
  const blocks = linearJsonContent(linearJsonSnapshot({ id: 1 }));
  const output = await linearJsonRead(context([{ ...blocks[0] }]));
  expect(output.kind).toBe("return");
  if (output.kind !== "return") throw new Error("Missing acquisition isolation failure");
  expect(output.result.details.failure?.code).toBe("UNSUPPORTED_CONTENT");
});

test("unrelated resolver content is left to its owner", async () => {
  const input = context([{ type: "text", text: "not JSON" }]);
  if (!input.state) throw new Error("Missing state");
  const other = { ...input, state: { ...input.state, resolvedBy: "filesystem" } };
  expect(await linearJsonRead(other)).toEqual({ kind: "continue", context: other });
});

test("page notices retain only verified continuation routes", () => {
  const page = { pageInfo: { hasNextPage: true, endCursor: "next" } };
  expect(linearApiPageCoverage(page, source + "#events", true)).toContain("?cursor=next#events");
  expect(linearApiPageCoverage(page, source, false)).not.toMatch(/linear:\/\//u);
  expect(
    linearApiPageCoverage(
      { pageInfo: { hasNextPage: true, endCursor: "bad\ncursor" } },
      source,
      true,
    ),
  ).not.toMatch(/linear:\/\//u);
  expect(linearApiPageCoverage(null, source, true)).toBeUndefined();
});
