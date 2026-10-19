import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  connectorCatalog,
  prepareConnector,
  stageConnectorState,
} from "#capabilities/connectors.ts";
import {
  registeredAliasRoutes,
  servedIdentity,
  validateRoute,
  type RunEvent,
} from "#capabilities/validation.ts";
import { sandboxArgs } from "#capabilities/sandbox.ts";

const roots: string[] = [];
async function fixture() {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/connector-test-"));
  roots.push(root);
  const stage = path.join(root, "stage");
  const packageRoot = path.join(stage, "node_modules/pi-claude-subscription-connector");
  await mkdir(path.join(packageRoot, "extensions"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "pi-claude-subscription-connector",
      version: "1.2.0",
      pi: { extensions: ["./extensions"] },
    }),
  );
  for (const name of ["subscription-guard.ts", "usage-status.ts"])
    await writeFile(path.join(packageRoot, "extensions", name), "export default () => {};\n");
  return { root, stage, packageRoot };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a connector run selects one pinned package and cannot change provider implicitly", async () => {
  const { stage, packageRoot } = await fixture();
  expect(connectorCatalog).toHaveLength(21);
  const connector = await prepareConnector(
    "subscription-connector",
    stage,
    "anthropic/claude-haiku-4-5",
  );
  expect(connector.extensions).toEqual([
    "/connector/node_modules/pi-claude-subscription-connector/extensions/subscription-guard.ts",
    "/connector/node_modules/pi-claude-subscription-connector/extensions/usage-status.ts",
  ]);
  expect(connector.metadata.version).toBe("1.2.0");
  await expect(
    prepareConnector("unlisted-connector", stage, "anthropic/claude-haiku-4-5"),
  ).rejects.toThrow("Unknown connector");
  await expect(
    prepareConnector("subscription-connector", stage, "openai-codex/gpt-6-luna"),
  ).rejects.toThrow("provider");
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "pi-claude-subscription-connector", version: "1.2.1" }),
  );
  await expect(
    prepareConnector("subscription-connector", stage, "anthropic/claude-haiku-4-5"),
  ).rejects.toThrow("pinned package");
});

test("directory manifests resolve to pinned executable files, not Pi -e directories", async () => {
  const { stage, packageRoot } = await fixture();
  const file = path.join(packageRoot, "extensions/usage-status.ts");
  await rm(file);
  await mkdir(file);
  await expect(
    prepareConnector("subscription-connector", stage, "anthropic/claude-haiku-4-5"),
  ).rejects.toThrow("regular file");
});
test("relative package-manager links stay inside the frozen dependency prefix", async () => {
  const { stage, packageRoot } = await fixture();
  const stored = path.join(stage, "stored");
  await mkdir(stored);
  const { rename } = await import("node:fs/promises");
  await rename(packageRoot, path.join(stored, "package"));
  await symlink(
    path.relative(path.dirname(packageRoot), path.join(stored, "package")),
    packageRoot,
  );
  const connector = await prepareConnector(
    "subscription-connector",
    stage,
    "anthropic/claude-haiku-4-5",
  );
  expect(connector.extensions).toEqual([
    "/connector/stored/package/extensions/subscription-guard.ts",
    "/connector/stored/package/extensions/usage-status.ts",
  ]);
  expect(connector.packagePath).toBe("/connector/stored/package");
});
test("only the explicit connector and Claude executable receive additional read-only mounts", async () => {
  const { root, stage } = await fixture();
  const executable = path.join(root, "selected-claude");
  const args = await sandboxArgs(root, root, { root: stage, executable });
  const mount = args.indexOf("/connector");
  expect(args.slice(mount - 2, mount + 1)).toEqual(["--ro-bind", stage, "/connector"]);
  const binary = args.indexOf("/tools/claude");
  expect(args.slice(binary - 2, binary + 1)).toEqual(["--ro-bind", executable, "/tools/claude"]);
  expect(args).not.toContain(path.join(root, "unselected-claude"));
});
test("connector code and dependency changes alter the recorded digest", async () => {
  const { stage } = await fixture();
  const first = await prepareConnector(
    "subscription-connector",
    stage,
    "anthropic/claude-haiku-4-5",
  );
  await mkdir(path.join(stage, "node_modules/dependency"));
  await writeFile(
    path.join(stage, "node_modules/dependency/index.js"),
    "export const value = 1;\n",
  );
  const second = await prepareConnector(
    "subscription-connector",
    stage,
    "anthropic/claude-haiku-4-5",
  );
  expect(second.metadata.digest).not.toBe(first.metadata.digest);
});

test("escaping package entrypoints fail closed", async () => {
  const { root, stage, packageRoot } = await fixture();
  await writeFile(path.join(root, "outside.ts"), "export default () => {};\n");
  await rm(path.join(packageRoot, "extensions"), { recursive: true });
  await symlink(path.join(root, "outside.ts"), path.join(packageRoot, "extensions"));
  await expect(
    prepareConnector("subscription-connector", stage, "anthropic/claude-haiku-4-5"),
  ).rejects.toThrow("escapes");
});

test("dedicated authentication snapshots never load settings or write the input state", async () => {
  const { root, stage } = await fixture();
  const connector = await prepareConnector(
    "subscription-connector",
    stage,
    "anthropic/claude-haiku-4-5",
  );
  const auth = path.join(root, "dedicated-pi");
  const state = path.join(root, "state");
  await mkdir(auth);
  const original = JSON.stringify({
    anthropic: {
      type: "oauth",
      access: "sk-ant-oat01-SYNTHETIC",
      refresh: "DO_NOT_COPY",
      expires: Date.now() + 3_600_000,
    },
  });
  await writeFile(path.join(auth, "auth.json"), original);
  await writeFile(path.join(auth, "settings.json"), "PERSONAL_SETTINGS_SENTINEL");
  await writeFile(path.join(auth, "models.json"), "PERSONAL_MODELS_SENTINEL");
  await expect(stageConnectorState(connector, state, {}, 120_000)).rejects.toThrow("dedicated Pi");
  await stageConnectorState(connector, state, { piAuthDir: auth }, 120_000);
  expect(await readFile(path.join(state, "agent/auth.json"), "utf8")).not.toContain("DO_NOT_COPY");
  await expect(readFile(path.join(state, "agent/settings.json"))).rejects.toThrow("ENOENT");
  await expect(readFile(path.join(state, "agent/models.json"))).rejects.toThrow("ENOENT");
  await writeFile(path.join(state, "agent/auth.json"), "CASE_ROTATED_TOKEN");
  expect(await readFile(path.join(auth, "auth.json"), "utf8")).toBe(original);
  expect(JSON.stringify(connector.metadata)).not.toContain(auth);
  expect(JSON.stringify(connector.metadata)).not.toContain("synthetic");
});

test("authentication symlinks and secret-bearing staged roots are refused", async () => {
  const { root, stage } = await fixture();
  const connector = await prepareConnector(
    "subscription-connector",
    stage,
    "anthropic/claude-haiku-4-5",
  );
  const auth = path.join(root, "dedicated");
  await mkdir(auth);
  await writeFile(path.join(root, "synthetic-auth"), "SYNTHETIC_SECRET");
  await symlink(path.join(root, "synthetic-auth"), path.join(auth, "auth.json"));
  await expect(
    stageConnectorState(connector, path.join(root, "state"), { piAuthDir: auth }, 120_000),
  ).rejects.toThrow("regular file");
  await writeFile(path.join(stage, ".npmrc"), "SYNTHETIC_SECRET");
  await expect(
    prepareConnector("subscription-connector", stage, "anthropic/claude-haiku-4-5"),
  ).rejects.toThrow("personal configuration");
});
test("Claude executable selection resolves a symlink and records only its content identity", async () => {
  const { root, stage } = await fixture();
  const packageRoot = path.join(stage, "node_modules/pi-claude-subscription");
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "pi-claude-subscription",
      version: "0.2.4",
      pi: { extensions: ["./src/index.ts"] },
    }),
  );
  await writeFile(path.join(packageRoot, "src/index.ts"), "export default () => {};\n");
  const executable = path.join(root, "claude-version");
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o700);
  const link = path.join(root, "claude");
  await symlink(executable, link);
  const connector = await prepareConnector(
    "subscription",
    stage,
    "claude-sdk/claude-haiku-4-5",
    link,
  );
  expect(connector.executable).toBe(executable);
  expect(connector.metadata.executableDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(connector.metadata)).not.toContain(executable);
  const auth = path.join(root, "dedicated-claude");
  await mkdir(auth);
  await writeFile(
    path.join(auth, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-SYNTHETIC",
        refreshToken: "DO_NOT_COPY",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
  await writeFile(path.join(auth, "settings.json"), "DO_NOT_LOAD_HOOKS");
  const state = path.join(root, "state");
  const staged = await stageConnectorState(connector, state, { claudeState: auth }, 120_000);
  expect(staged.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-SYNTHETIC");
  await expect(readFile(path.join(state, "home/.claude/.credentials.json"))).rejects.toThrow(
    "ENOENT",
  );
  await expect(readFile(path.join(state, "home/.claude/settings.json"))).rejects.toThrow("ENOENT");
});

const textResult = {
  content: [{ type: "text", text: "<uuid>9b901a2b-a965-4729-8abb-3c09c3cbc6c2</uuid>\nsource" }],
};
function aliasEvents(): RunEvent[] {
  return [
    {
      type: "tool_execution_start",
      toolCallId: "parent",
      toolName: "codemode",
      args: { code: "tools.mcp__ide__read({path:'task.txt'})" },
    },
    {
      type: "tool_execution_start",
      toolCallId: "alias",
      parentToolCallId: "parent",
      toolName: "mcp__ide__read",
      args: { path: "task.txt" },
    },
    {
      type: "tool_execution_start",
      toolCallId: "read",
      parentToolCallId: "alias",
      toolName: "read",
      args: { path: "task.txt" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "read",
      parentToolCallId: "alias",
      toolName: "read",
      isError: false,
      result: textResult,
    },
    {
      type: "tool_execution_end",
      toolCallId: "alias",
      parentToolCallId: "parent",
      toolName: "mcp__ide__read",
      isError: false,
      result: textResult,
    },
    {
      type: "tool_execution_end",
      toolCallId: "parent",
      toolName: "codemode",
      isError: false,
      result: textResult,
    },
  ];
}
test("only evidenced transparent alias ancestry counts as a native Codemode route", () => {
  const events = aliasEvents();
  const task = { steps: [{ tool: "read", args: { path: "task.txt" } }] };
  const aliases = { mcp__ide__read: "read" };
  expect(validateRoute(task, events, "codemode").passed).toBe(false);
  expect(validateRoute(task, events, "codemode", aliases).passed).toBe(true);
  expect(events[1]?.toolName).toBe("mcp__ide__read");
  const changed = events.map((event) =>
    event.toolCallId === "alias" && event.type === "tool_execution_start"
      ? { ...event, args: { path: "different.txt" } }
      : event,
  );
  expect(validateRoute(task, changed, "codemode", aliases).passed).toBe(false);
  const missing = events.filter((event) => event.toolCallId !== "read");
  expect(validateRoute(task, missing, "codemode", aliases).passed).toBe(false);
  const originalRead = events.find(
    (event) => event.type === "tool_execution_start" && event.toolName === "read",
  );
  if (!originalRead) throw Error("Missing native Read execution");
  const duplicate = [
    ...events.slice(0, 4),
    { ...originalRead, toolCallId: "second-read" },
    ...events.slice(4),
  ];
  expect(validateRoute(task, duplicate, "codemode", aliases).passed).toBe(false);
  const foreign = { mcp__foreign__read: "read" };
  expect(validateRoute(task, events, "codemode", foreign).passed).toBe(false);
});

test("foreign or structurally different MCP tools cannot authorize alias ancestry", () => {
  const parameters = { type: "object", properties: { path: { type: "string" } } };
  const source = {
    name: "read",
    namespace: { name: "ide_read" },
    sourceInfo: { path: "/source/src/read.ts" },
    parameters,
  };
  const alias = {
    name: "mcp__ide__read",
    sourceInfo: { path: "/connector/node_modules/adapter/index.ts" },
    parameters,
  };
  expect(registeredAliasRoutes([source, alias], "/connector/node_modules/adapter")).toEqual({
    mcp__ide__read: "read",
  });
  expect(
    registeredAliasRoutes(
      [source, { ...alias, sourceInfo: { path: "/foreign/server.ts" } }],
      "/connector/node_modules/adapter",
    ),
  ).toEqual({});
  expect(
    registeredAliasRoutes(
      [source, { ...alias, parameters: { type: "string" } }],
      "/connector/node_modules/adapter",
    ),
  ).toEqual({});
  expect(
    registeredAliasRoutes(
      [source, { ...alias, namespace: { name: "mcp__foreign" } }],
      "/connector/node_modules/adapter",
    ),
  ).toEqual({});
  expect(registeredAliasRoutes([source, alias], "/host/personal")).toEqual({});
});
test("served provider and model are distinct evidence from the requested runtime identity", () => {
  const events: RunEvent[] = [
    {
      type: "message_end",
      message: { role: "assistant", provider: "anthropic", model: "claude-haiku-4-5", content: [] },
    },
  ];
  expect(servedIdentity(events, "anthropic/claude-haiku-4-5")).toEqual({
    identities: ["anthropic/claude-haiku-4-5"],
    reasons: [],
  });
  expect(servedIdentity(events, "claude-sdk/claude-haiku-4-5").reasons).toContain(
    "Served provider/model differs from the requested profile",
  );
  expect(servedIdentity([], "anthropic/claude-haiku-4-5").reasons).toContain(
    "No served provider/model identity was observed",
  );
  const response: RunEvent[] = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        responseModel: "claude-haiku-4-5-snapshot",
      },
    },
  ];
  expect(servedIdentity(response, "anthropic/claude-haiku-4-5").reasons).toContain(
    "Reported response model differs from the expected served model",
  );
  expect(
    servedIdentity(response, "anthropic/claude-haiku-4-5", "claude-haiku-4-5-snapshot"),
  ).toEqual({
    identities: ["anthropic/claude-haiku-4-5"],
    responseModels: ["claude-haiku-4-5-snapshot"],
    reasons: [],
  });
});
