import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Problem } from "pi-problem-report";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registerBuiltinModules } from "./module-registration.ts";
import { createIdeProblemReports, guardExtensionApi, type GuardOwner } from "./problem-reports.ts";

type Hook = (event: unknown, context: unknown) => unknown;

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test value");
  return value;
}

/** The registration surface the guard wraps, recording what reaches Pi. */
function fakeApi() {
  const hooks = new Map<string, Hook[]>();
  const tools = new Map<string, ToolDefinition>();
  const api: Pick<ExtensionAPI, "on" | "registerTool" | "events"> = {
    on: ((event: string, hook: Hook) => {
      hooks.set(event, [...(hooks.get(event) ?? []), hook]);
    }) as ExtensionAPI["on"],
    registerTool: ((tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    }) as ExtensionAPI["registerTool"],
    events: { on: () => () => {}, emit: () => {} },
  };
  const hook = (event: string, index = 0) => present(hooks.get(event)?.[index]);
  const tool = (name: string) => present(tools.get(name));
  return { api: api as ExtensionAPI, hooks, hook, tool };
}

function guarded(owner: GuardOwner = { id: "lsp" }) {
  const host = fakeApi();
  const problems: Problem[] = [];
  const api = guardExtensionApi(host.api, owner, (problem) => problems.push(problem));
  return { ...host, api, problems };
}

const brokenComponent = (): Component => ({
  render: () => {
    throw new TypeError("cannot read width");
  },
  invalidate: () => {},
});

function tool(overrides: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: "read",
    label: "Read",
    description: "",
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [], details: undefined }),
    ...overrides,
  };
}

const run = (definition: ToolDefinition) =>
  definition.execute("call", {}, undefined, undefined, {} as never);

describe("IDE problem guards", () => {
  test("an internal tool error is reported and still reaches the agent as the tool error", async () => {
    const { api, tool: registered, problems } = guarded();
    const bug = new TypeError("cannot read properties of undefined");
    api.registerTool(tool({ name: "lsp_search", execute: () => Promise.reject(bug) }));
    await expect(run(registered("lsp_search"))).rejects.toBe(bug);
    expect(problems.map((problem) => problem.error)).toEqual([bug]);
  });

  test("an expected tool error, such as a missing file, is not reported", async () => {
    const { api, tool: registered, problems } = guarded();
    const missing = new Error("ENOENT: no such file");
    api.registerTool(tool({ execute: () => Promise.reject(missing) }));
    await expect(run(registered("read"))).rejects.toBe(missing);
    expect(problems).toEqual([]);
  });

  test("a result renderer that throws while drawing does not throw into the frame", () => {
    const { api, tool: registered, problems } = guarded();
    api.registerTool(tool({ renderResult: brokenComponent }));
    const component = present(registered("read").renderResult)(
      { content: [], details: undefined },
      { expanded: false, isPartial: false },
      {} as never,
      {} as never,
    );
    expect(() => component.render(40)).not.toThrow();
    expect(problems).toHaveLength(1);
  });

  test("a tool definition keeps its live description", () => {
    const { api, tool: registered } = guarded();
    let description = "first";
    api.registerTool({
      ...tool({}),
      get description() {
        return description;
      },
    });
    description = "second";
    expect(registered("read").description).toBe("second");
  });

  test("an internal error in an event handler is reported and still reaches Pi", async () => {
    const { api, hook, problems } = guarded();
    const bug = new ReferenceError("state is not defined");
    api.on("tool_result", () => Promise.reject(bug));
    await expect(hook("tool_result")({}, {})).rejects.toBe(bug);
    expect(problems.map((problem) => problem.error)).toEqual([bug]);
  });

  test("a widget whose component throws while drawing does not throw into the frame", async () => {
    const { api, hook, problems } = guarded();
    let widget: unknown;
    const ui = {
      setWidget: (_key: string, content: unknown) => {
        widget = content;
      },
    };
    api.on("session_start", (_event, context) => {
      context.ui.setWidget("ide-processes", brokenComponent);
    });
    await hook("session_start")({}, { ui, hasUI: true });
    const component = (widget as () => Component)();
    expect(() => component.render(40)).not.toThrow();
    expect(problems).toHaveLength(1);
  });
});

describe("module registration", () => {
  const started: string[] = [];
  const module = (id: string, register: () => void, dependencies: string[] = []) => ({
    id,
    dependencies,
    register: (pi: ExtensionAPI) => {
      pi.on("session_start", () => {
        started.push(id);
      });
      register();
    },
  });

  test("a module that throws while registering leaves the other modules working", async () => {
    const { api, hooks } = fakeApi();
    const problems: Problem[] = [];
    const failure = new Error("Plugin ide-output-retention is already registered");
    const failed = await registerBuiltinModules(
      [
        module("read", () => {}),
        module("lsp", () => {
          throw failure;
        }),
        module("diagnostics", () => {}, ["lsp"]),
        module("terminal", () => {}),
      ],
      api,
      { preferences: {} },
      {
        guard: (target, owner) => guardExtensionApi(target, owner, () => {}),
        report: (problem) => problems.push(problem),
      },
    );
    expect([...failed]).toEqual(["lsp", "diagnostics"]);
    expect(problems.map((problem) => problem.error)).toEqual([failure]);
    for (const startHook of hooks.get("session_start") ?? []) await startHook({}, {});
    // The failed module registered its hook before throwing; that hook no longer runs.
    expect(started).toEqual(["read", "terminal"]);
  });
});

describe("IDE crash offers", () => {
  const REJECTION_GUARD = Symbol.for("pi-problem-report.rejection-guard");
  let agentDir = "";

  beforeEach(() => {
    agentDir = mkdtempSync(path.join(tmpdir(), "ide-crash-offers-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const crash = {
      timestamp: new Date().toISOString(),
      message: "Plugin ide-output-retention is already registered",
      stack: `Error: Plugin ide-output-retention is already registered\n    at register (${path.resolve("src/extensions/pi-agent-read/index.ts")}:1:1)`,
    };
    writeFileSync(path.join(agentDir, "crashes.json"), JSON.stringify([crash]));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(agentDir, { recursive: true, force: true });
    // Session start installs a process-wide rejection listener; keep it out of other tests.
    const global = globalThis as { [REJECTION_GUARD]?: { listener: (reason: unknown) => void } };
    const registry = global[REJECTION_GUARD];
    if (registry) process.off("unhandledRejection", registry.listener);
    delete global[REJECTION_GUARD];
  });

  async function startSession(enabled: boolean) {
    const hooks = new Map<string, Hook>();
    const setWidget = vi.fn();
    createIdeProblemReports(
      {
        on: ((event: string, hook: Hook) => {
          hooks.set(event, hook);
          return () => {};
        }) as ExtensionAPI["on"],
        registerCommand: () => {},
      },
      { enabled: () => enabled, disable: () => Promise.resolve() },
    );
    await present(hooks.get("session_start"))({}, { hasUI: true, ui: { setWidget, notify() {} } });
    return setWidget.mock.calls.some(([, content]) => typeof content === "function");
  }

  test("a crash inside the IDE is offered once", async () => {
    expect(await startSession(true)).toBe(true);
    expect(await startSession(true)).toBe(false);
  });

  test("a crash is kept for later while problem reports are off", async () => {
    expect(await startSession(false)).toBe(false);
    expect(await startSession(true)).toBe(true);
  });
});
