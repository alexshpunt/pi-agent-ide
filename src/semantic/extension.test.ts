import { expect, test, vi } from "vitest";
import {
  createConfiguredSemanticExtension,
  createSemanticExtension,
  type SemanticBackend,
} from "./extension.js";

type Context = ReturnType<typeof context>;
type Tool = {
  name: string;
  exposure: string;
  execute(
    id: string,
    params: { query: string },
    signal: undefined,
    update: undefined,
    context: Context,
  ): Promise<{ content: { text: string }[] }>;
};
type Handler = (event: unknown, context: Context) => Promise<void>;
type Command = { handler(args: string, context: Context): Promise<void> };

function host() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const tools = new Map<string, Tool>();
  let active: string[] = [];
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerTool: (tool: Tool) => {
      tools.set(tool.name, tool);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    getSettings: () => ({}),
  };
  return { pi: pi as never, handlers, commands, tools, active: () => active };
}

const context = (cwd: string) => ({ cwd, mode: "tui", hasUI: true, ui: { notify: vi.fn() } });

test("an invalid engine setting does not prevent the IDE from loading or use another backend", async () => {
  const h = host();
  const backend: SemanticBackend = {
    available: vi.fn(async () => true),
    index: vi.fn(async () => {}),
    search: vi.fn(async () => "result"),
  };
  await createConfiguredSemanticExtension({ colgrep: backend, vera: backend }, "invalid")(h.pi);
  const project = context("/project");
  await h.handlers.get("session_start")?.({}, project);
  expect(h.tools.get("semantic_search")?.exposure).toBe("hidden");
  await h.commands.get("semantic-index")?.handler("", project);
  expect(project.ui.notify.mock.calls.some((call) => call[1] === "error")).toBe(true);
  expect(backend.available).not.toHaveBeenCalled();
  expect(backend.index).not.toHaveBeenCalled();
});
test("the selected engine owns availability, indexing and search", async () => {
  const h = host();
  let veraIndexed = false;
  const colgrep: SemanticBackend = {
    available: vi.fn(async () => true),
    index: vi.fn(async () => {}),
    search: vi.fn(async () => "wrong"),
  };
  const vera: SemanticBackend = {
    available: vi.fn(async () => veraIndexed),
    index: vi.fn(async () => {
      veraIndexed = true;
    }),
    search: vi.fn(async () => "selected result"),
  };
  await createConfiguredSemanticExtension({ colgrep, vera }, "vera")(h.pi);
  await h.handlers.get("session_start")?.({}, context("/project"));
  expect(h.tools.get("semantic_search")?.exposure).toBe("hidden");
  await h.commands.get("semantic-index")?.handler("", context("/project"));
  const tool = h.tools.get("semantic_search");
  expect(tool?.exposure).toBe("direct");
  if (!tool) throw new Error("Tool not registered");
  const result = await tool.execute(
    "id",
    { query: "example" },
    undefined,
    undefined,
    context("/project"),
  );
  expect(result.content[0]?.text).toBe("selected result");
  expect(vera.index).toHaveBeenCalledOnce();
  expect(vera.search).toHaveBeenCalledOnce();
  expect(colgrep.available).not.toHaveBeenCalled();
  expect(colgrep.index).not.toHaveBeenCalled();
  expect(colgrep.search).not.toHaveBeenCalled();
});
test("only exposes semantic search while the current project has a usable index", async () => {
  const h = host();
  const indexed = new Set(["/indexed"]);
  const backend: SemanticBackend = {
    available: async (cwd) => indexed.has(cwd),
    index: vi.fn(async (cwd: string) => {
      indexed.add(cwd);
    }),
    search: vi.fn(async () => "src/example.ts:1-2"),
  };
  await createSemanticExtension(backend)(h.pi);
  await h.handlers.get("session_start")?.({}, context("/empty"));
  expect(h.tools.get("semantic_search")?.exposure ?? "hidden").toBe("hidden");
  await h.handlers.get("before_agent_start")?.({}, context("/indexed"));
  const tool = h.tools.get("semantic_search");
  expect(tool?.exposure).toBe("direct");
  if (!tool) throw new Error("Tool not registered");
  const result = await tool.execute(
    "id",
    { query: "example" },
    undefined,
    undefined,
    context("/indexed"),
  );
  expect(result.content[0]?.text).toContain("src/example.ts:1-2");
  await h.handlers.get("before_agent_start")?.({}, context("/empty"));
  expect(h.tools.get("semantic_search")?.exposure).toBe("hidden");
  expect(h.active()).not.toContain("semantic_search");
});

test("index progress from the selected backend reaches the user", async () => {
  const h = host();
  let indexed = false;
  const backend: SemanticBackend = {
    available: async () => indexed,
    index: async (_cwd, _signal, progress) => {
      progress?.("fixture engine progress");
      indexed = true;
    },
    search: vi.fn(async () => "result"),
  };
  await createSemanticExtension(backend)(h.pi);
  const project = context("/project");
  await h.commands.get("semantic-index")?.handler("", project);
  expect(project.ui.notify.mock.calls.some((call) => call[0] === "fixture engine progress")).toBe(
    true,
  );
});
test("a failed index does not enable semantic search", async () => {
  const h = host();
  const backend: SemanticBackend = {
    available: async () => false,
    index: async () => {
      throw new Error("index failed");
    },
    search: vi.fn(async () => "result"),
  };
  await createSemanticExtension(backend)(h.pi);
  const project = context("/project");
  await h.handlers.get("session_start")?.({}, project);
  await h.commands.get("semantic-index")?.handler("", project);
  expect(h.tools.get("semantic_search")?.exposure).toBe("hidden");
  expect(project.ui.notify.mock.calls.some((call) => call[1] === "error")).toBe(true);
});

test("explicit indexing enables search for that project and not another", async () => {
  const h = host();
  const indexed = new Set<string>();
  const backend: SemanticBackend = {
    available: async (cwd) => indexed.has(cwd),
    index: async (cwd) => {
      indexed.add(cwd);
    },
    search: vi.fn(async () => "result"),
  };
  await createSemanticExtension(backend)(h.pi);
  const first = context("/first");
  await h.handlers.get("session_start")?.({}, first);
  await h.commands.get("semantic-index")?.handler("", first);
  expect(h.tools.get("semantic_search")?.exposure).toBe("direct");
  await h.handlers.get("before_agent_start")?.({}, context("/second"));
  expect(h.tools.get("semantic_search")?.exposure).toBe("hidden");
});
