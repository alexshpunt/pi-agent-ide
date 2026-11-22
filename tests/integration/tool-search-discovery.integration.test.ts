import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { requiredValue } from "pi-agent-invariant";
import { afterAll, beforeAll, expect, test } from "vitest";

const entry = path.resolve("src/pi-agent-ide.ts");
const root = path.resolve(".tmp/tool-search-discovery");

/**
 * Queries an agent writes to find a deferred IDE tool: its name, the words of its description or
 * the IDE's discovery guidance, and the queries models wrote in paid capability runs.
 */
const queries: [query: string, tool: string][] = [
  ["ast_search", "ast_search"],
  ["lsp_search", "lsp_search"],
  ["diff", "diff"],
  ["undo", "undo"],
  ["stage", "stage"],
  ["unstage", "unstage"],
  ["debug", "debug"],
  ["ide_debug debug", "debug"],
  [
    "ast_search structural code search syntax patterns captures enclosing functions classes",
    "ast_search",
  ],
  [
    "lsp_search find symbol declarations references definitions and call graph through language server",
    "lsp_search",
  ],
  ["diff compare two text-readable sources", "diff"],
  ["undo restore last text edit or uncommitted Git change", "undo"],
  [
    "structural code search: syntax patterns, captures and enclosing functions or classes",
    "ast_search",
  ],
  ["find code by syntax with ast-grep patterns", "ast_search"],
  [
    "navigation through language servers: symbol definitions, references and call graphs",
    "lsp_search",
  ],
  ["find the definition of a symbol", "lsp_search"],
  ["jump to definition", "lsp_search"],
  ["list a symbol's calls and references", "lsp_search"],
  ["comparing text sources", "diff"],
  ["compare two files", "diff"],
  ["reverting the last text edit or an uncommitted Git change", "undo"],
  ["revert the last edit", "undo"],
  ["add a selected Git change to the index", "stage"],
  ["remove a selected Git change from the index", "unstage"],
  ["creating a debugger session", "debug"],
  ["debug a program with breakpoints", "debug"],
];

interface Fixture {
  session: AgentSession;
  cwd: string;
  /** Pi's own tool_search, registered against the session's real extension API. */
  toolSearch: ToolDefinition;
  initial: string[];
}
let fixture: Fixture | undefined;
const previousCwd = process.cwd();
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeAll(async () => {
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), "{}");
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let api: ExtensionAPI | undefined;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    additionalExtensionPaths: [entry],
    extensionFactories: [
      createCodemodeExtension(),
      createToolSearchExtension(),
      (pi) => {
        api = pi;
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  await session.bindExtensions({
    onError: (error) => {
      throw new Error(error.error);
    },
  });
  // Build a second tool_search definition whose registry calls reach the session's runtime.
  let toolSearch: ToolDefinition | undefined;
  const registerTool = ((definition: ToolDefinition) => {
    toolSearch = definition;
  }) as ExtensionAPI["registerTool"];
  await createToolSearchExtension()({ ...requiredValue(api), registerTool });
  fixture = {
    session,
    cwd,
    toolSearch: requiredValue(toolSearch),
    initial: session.getActiveToolNames(),
  };
}, 120_000);

afterAll(async () => {
  fixture?.session.dispose();
  process.chdir(previousCwd);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (fixture) await rm(fixture.cwd, { recursive: true, force: true });
});

test("a fresh session starts with the optional IDE tools deferred and tool_search active", () => {
  const { session, initial } = requiredValue(fixture);
  expect(initial).toContain("tool_search");
  for (const name of ["ast_search", "lsp_search", "diff", "undo", "stage", "unstage", "debug"]) {
    expect(initial).not.toContain(name);
    expect(session.getAllTools().find((tool) => tool.name === name)?.exposure).toBe("deferred");
  }
});

test.each(queries)("tool_search %j loads %s first", async (query, tool) => {
  const { session, toolSearch, initial } = requiredValue(fixture);
  session.setActiveToolsByName(initial);
  const result = await toolSearch.execute(
    "search",
    { query },
    undefined,
    undefined,
    undefined as never,
  );
  expect((result.details as { loaded: string[] }).loaded[0]).toBe(tool);
  expect(session.getActiveToolNames()).toContain(tool);
});
