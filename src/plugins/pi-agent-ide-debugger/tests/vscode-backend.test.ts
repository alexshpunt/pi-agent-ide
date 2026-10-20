import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";
import {
  isInside,
  vscodePath,
  VscodeDebugSession,
} from "#src/plugins/pi-agent-ide-debugger/src/vscode-backend.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0)) await close();
});

interface FakeSession {
  readonly configurationName: string;
  line: number;
  name: string;
}

/**
 * DebugMCP stand-in that answers with the extension's text formats over SSE. A remote window
 * reports frames as `name:line` stack entries without a file, as VS Code Remote does.
 */
async function fakeDebugMcp(workspace: string, activeSession?: FakeSession, remote = false) {
  const program = path.join(workspace, "task.py");
  const state = {
    breakpoints: [] as { file: string; line: number }[],
    session: activeSession,
  };
  const tools: Record<string, (args: Record<string, unknown>) => string> = {
    remove_breakpoint: ({ fileFullPath, line }) => {
      state.breakpoints = state.breakpoints.filter(
        (breakpoint) => breakpoint.file !== fileFullPath || breakpoint.line !== line,
      );
      return "Breakpoint removed";
    },
    add_breakpoint: ({ fileFullPath, line }) => {
      state.breakpoints.push({ file: String(fileFullPath), line: Number(line) });
      return `Breakpoint added at ${String(fileFullPath)}:${Number(line)}`;
    },
    list_breakpoints: () =>
      state.breakpoints.length === 0
        ? "No breakpoints currently set"
        : `Active Breakpoints:\n${state.breakpoints
            .map(
              (breakpoint, index) =>
                `${index + 1}. Breakpoint ${path.basename(breakpoint.file)}:${breakpoint.line}`,
            )
            .join("\n")}\n`,
    start_debugging: () => {
      const line = Math.min(...state.breakpoints.map((breakpoint) => breakpoint.line));
      state.session = { configurationName: "Python: Current File", line, name: "total" };
      return `Debug session stopped at breakpoint for: ${program}. Current state: {}`;
    },
    step_over: () => {
      if (state.session !== undefined) {
        state.session.line++;
        if (state.session.line > 2) state.session.name = "<module>";
      }
      return "{}";
    },
    get_debug_status: () =>
      JSON.stringify(
        state.session === undefined
          ? { status: "no-session", paused: false, sessionActive: false }
          : {
              status: "paused",
              paused: true,
              sessionActive: true,
              configurationName: state.session.configurationName,
              state: {
                fileFullPath: remote ? null : program,
                currentLine: remote ? null : state.session.line,
                stackTrace: [`${state.session.name}:${state.session.line}`],
                frameId: 7,
                threadId: 3,
                frameName: state.session.name,
              },
            },
      ),
    list_variable_names: () =>
      "Variables in scope (names only - no values were read):\n=====\n\nLocals:\n  value (int)\n  items (list)\n\nUse get_variables_values with the names you need.\n",
    get_variables_values: () =>
      "Variables:\n==========\n\nLocals:\n  value: 42 (int)\n  items (list)\n    [0] (int)\n\n",
    evaluate_expression: ({ expression }) => `Expression: ${String(expression)}\nResult: 42 (int)`,
    stop_debugging: () => {
      state.session = undefined;
      return "Debug session stopped successfully";
    },
  };
  const server = http.createServer((request, response) => {
    if (request.method === "DELETE") {
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const message = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: { name: string; arguments: Record<string, unknown> };
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "debugmcp" } }
          : {
              content: [
                {
                  type: "text",
                  text: tools[message.params?.name ?? ""]?.(message.params?.arguments ?? {}),
                },
              ],
            };
      response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" });
      response.end(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test port");
  vi.stubEnv("PI_DEBUGMCP_PORT", String(address.port));
  return { program, state };
}

/** Register a live VS Code window for the workspace in a private home directory. */
async function vscodeWorkspace() {
  const home = await mkdtemp(path.join(tmpdir(), "pi-debugmcp-home-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  vi.stubEnv("HOME", home);
  const workspace = path.join(home, "project");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "task.py"), "value = 42\nitems = [value]\nprint(items)\n");
  const registry = path.join(
    home,
    ".vscode-server/data/User/globalStorage/ozzafar.debugmcpextension/window-registry",
  );
  await mkdir(registry, { recursive: true });
  await writeFile(
    path.join(registry, `window-${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      name: "project",
      workspaceFolders: [workspace],
      updatedAt: Date.now(),
    }),
  );
  return { home, workspace };
}

test("debugs through VS Code and leaves the user's breakpoint in place", async () => {
  const { workspace } = await vscodeWorkspace();
  const { program, state } = await fakeDebugMcp(workspace);
  state.breakpoints.push({ file: program, line: 1 });
  const vscode = await VscodeDebugSession.open({ cwd: workspace, program, sourceFile: program });
  const manager = new DebugSessionManager();
  const session = manager.create(
    { adapter: "vscode", program, sourceFile: program, args: [], cwd: workspace },
    vscode,
  );

  await manager.addBreakpoint(`${session.source}/source`, 1);
  await manager.addBreakpoint(`${session.source}/source`, 2);
  await manager.start(session);

  expect(session.status).toBe("stopped");
  expect(session.stop?.frame?.line).toBe(1);
  expect(session.stop?.reason).toBe("breakpoint");
  expect(session.stop?.variables).toEqual([
    { name: "value", value: "42", type: "int", variablesReference: 0 },
    { name: "items", value: "<complex value>", type: "list", variablesReference: 0 },
  ]);
  await expect(manager.evaluate(session, "value")).resolves.toMatchObject({
    result: "42",
    type: "int",
  });
  await manager.command(session, "next");
  expect(session.stop?.frame?.line).toBe(2);

  await manager.delete(session.source);

  expect(state.breakpoints).toEqual([{ file: program, line: 1 }]);
  expect(state.session).toBeUndefined();
});

test("infers frame files that a remote VS Code window does not report", async () => {
  const { workspace } = await vscodeWorkspace();
  const { program } = await fakeDebugMcp(workspace, undefined, true);
  const vscode = await VscodeDebugSession.open({ cwd: workspace, program, sourceFile: program });
  const manager = new DebugSessionManager();
  const session = manager.create(
    { adapter: "vscode", program, sourceFile: program, args: [], cwd: workspace },
    vscode,
  );
  await manager.addBreakpoint(`${session.source}/source`, 1);

  await manager.start(session);
  expect(session.stop?.frame).toMatchObject({ name: "total", line: 1, source: { path: program } });
  expect(session.stop?.reason).toBe("breakpoint");
  await manager.command(session, "next");
  expect(session.stop?.frame).toMatchObject({ name: "total", line: 2, source: { path: program } });
  await manager.command(session, "next");
  expect(session.stop?.frame).toEqual({ id: 7, name: "<module>", line: 3 });
  await expect(manager.evaluate(session, "value")).resolves.toMatchObject({ result: "42" });

  await manager.delete(session.source);
});

test("refuses a VS Code window whose debug session Pi did not start", async () => {
  const { workspace } = await vscodeWorkspace();
  const userSession = { configurationName: "User launch", line: 1, name: "<module>" };
  const { program, state } = await fakeDebugMcp(workspace, userSession);

  await expect(
    VscodeDebugSession.open({ cwd: workspace, program, sourceFile: program }),
  ).rejects.toThrow("already has an active debug session");
  expect(state.session).toBe(userSession);
});

test("matches Windows workspace folders regardless of letter case", () => {
  expect(isInside("C:\\dev\\cc-dev\\build\\app.exe", "c:\\dev\\cc-dev", "win32")).toBe(true);
  expect(isInside("C:\\DEV\\CC-DEV", "c:\\dev\\cc-dev", "win32")).toBe(true);
  expect(isInside("C:\\dev\\cc-dev-other", "c:\\dev\\cc-dev", "win32")).toBe(false);
  expect(isInside("/home/User/project", "/home/user/project", "linux")).toBe(false);
});

test("spells Windows breakpoint paths with VS Code's lower-case drive letter", () => {
  expect(vscodePath("C:\\dev\\cc-dev\\main.cpp", "win32")).toBe("c:\\dev\\cc-dev\\main.cpp");
  expect(vscodePath("c:\\Dev\\Main.cpp", "win32")).toBe("c:\\Dev\\Main.cpp");
  expect(vscodePath("/home/User/main.cpp", "linux")).toBe("/home/User/main.cpp");
});

test("asks for a launch configuration before starting an executable", async () => {
  const { workspace } = await vscodeWorkspace();
  const { program, state } = await fakeDebugMcp(workspace);
  const vscode = await VscodeDebugSession.open({ cwd: workspace, program, sourceFile: program });
  const executable = path.join(workspace, "app.exe");

  await expect(vscode.start({ program: executable, cwd: workspace })).rejects.toThrow(
    "Add a .vscode/launch.json configuration",
  );
  expect(state.session).toBeUndefined();
  await vscode.close();
});

test("reports when no VS Code window has the workspace open", async () => {
  const { home } = await vscodeWorkspace();
  const elsewhere = path.join(home, "elsewhere");
  await mkdir(elsewhere);
  const program = path.join(elsewhere, "task.py");

  await expect(
    VscodeDebugSession.open({ cwd: elsewhere, program, sourceFile: program }),
  ).rejects.toThrow(`No running VS Code window with DebugMCP has ${elsewhere} open`);
});
