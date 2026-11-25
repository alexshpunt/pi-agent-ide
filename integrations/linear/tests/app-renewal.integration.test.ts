import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const backend = path.join(root, "tests/fixtures/app-renewal-cli.mjs");
const documentId = "71000000-0000-4000-8000-000000000006";
const scope = ["read", "write", "comments:create", "app:assignable", "webhook"];
const oldToken = "synthetic-pi-installed-app-token";
const newToken = "synthetic-pi-renewed-app-token";
const clientSecret = "synthetic-pi-app-client-secret";
const viewer = {
  id: "fixture-pi-app",
  name: "Synthetic renewing app",
  app: true,
  organization: { id: "fixture-pi-workspace", name: "Synthetic workspace", urlKey: "example" },
};
async function auth(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  const child = spawn(process.execPath, [backend, "auth", ...args, "--json"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (errors += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  expect(code, output + errors).toBe(0);
  const receipt: unknown = JSON.parse(output);
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    !("connectionId" in receipt) ||
    typeof receipt.connectionId !== "string"
  ) {
    return undefined;
  }
  const epoch = "epoch" in receipt && typeof receipt.epoch === "string" ? receipt.epoch : undefined;
  return { connectionId: receipt.connectionId, epoch };
}

test("real Pi restores an expired installed App, renews it and reads with the same saved identity", async () => {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/app-renewal-"));
  const requests: Array<{ url: string; authorization?: string; body: string }> = [];
  const document = {
    id: documentId,
    title: "Synthetic renewal document",
    url: `https://linear.app/example/document/synthetic-renewal-${documentId.replaceAll("-", "").slice(-12)}`,
    content: "A document read after App token renewal.",
  };
  let fixtureFailure: unknown;
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url ?? "", authorization: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/oauth/token") {
      response.end(
        JSON.stringify({
          access_token: newToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: scope.join(" "),
        }),
      );
    } else if (request.url === "/graphql") {
      response.end(JSON.stringify({ data: { viewer } }));
    } else if (request.url === "/mcp" && request.method === "POST") {
      const message = JSON.parse(body) as {
        id?: string | number | null;
        method: string;
        params?: { protocolVersion?: string; name?: string };
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic-app-renewal", version: "1" },
        };
      } else if (message.method === "tools/list") {
        result = {
          tools: [
            {
              name: "get_document",
              description: "Read a synthetic document",
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
            },
          ],
        };
      } else if (message.method === "tools/call" && message.params?.name === "get_document") {
        result = { content: [{ type: "text", text: JSON.stringify(document) }] };
      } else {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Unknown fixture method" },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } else {
      response.writeHead(405).end();
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      fixtureFailure ??= error;
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const connectionFile = path.join(cwd, "connection.json");
  const cacheFile = path.join(cwd, "app-token.json");
  const envFile = path.join(cwd, "isolated.env");
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: cwd,
    XDG_CONFIG_HOME: cwd,
    PI_CODING_AGENT_DIR: path.join(cwd, "agent"),
    CODEX_CONFIG: path.join(cwd, "absent-codex.toml"),
    // Relative paths follow Pi's staged workspace and are copied back after a shared run.
    LINEAR_AXI_ENV_FILE: path.basename(envFile),
    LINEAR_AXI_CONNECTION_FILE: path.basename(connectionFile),
    LINEAR_TEST_HTTP_ORIGIN: address,
    LINEAR_AXI_TOKEN_FILE: path.basename(cacheFile),
    LINEAR_AXI_CLIENT_ID: "synthetic-pi-app-client",
    LINEAR_AXI_CLIENT_SECRET: clientSecret,
    LINEAR_AXI_TOKEN_SCOPE: scope.join(","),
    LINEAR_AXI_TOKEN_URL: address + "/oauth/token",
    LINEAR_AXI_GRAPHQL_URL: address + "/graphql",
    LINEAR_AXI_MCP_URL: address + "/mcp",
  };
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/linear.json"), JSON.stringify({ axiPath: backend }));
    await writeFile(envFile, "");
    const cache = JSON.stringify({ accessToken: oldToken, expiresAt: Date.now() + 3600_000 });
    await writeFile(cacheFile, cache, { mode: 0o600 });
    const connected = await auth(cwd, environment, [
      "connect-app",
      "--name",
      "Renewing fixture app",
    ]);
    if (!connected?.epoch) throw new Error("Connect-app did not return a connection and epoch");
    await auth(cwd, environment, ["default", "--id", connected.connectionId]);
    await auth(cwd, { ...environment, LINEAR_AXI_CONNECTION_ID: connected.connectionId }, [
      "enable-app-renewal",
      "--scope",
      scope.join(","),
    ]);
    const grantFile = path.join(connectionFile + ".connections", connected.connectionId + ".json");
    const grant = JSON.parse(await readFile(grantFile, "utf8")) as {
      credential: { expiresAt: number };
    };
    grant.credential.expiresAt = Date.now() - 1000;
    await writeFile(grantFile, JSON.stringify(grant), { mode: 0o600 });
    const catalog = await readFile(connectionFile + ".profiles.json", "utf8");
    requests.length = 0;
    const result = await new PiIntegrationTest({
      testName: "linear-installed-app-renewal",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      timeoutMs: 90_000,
      environment,
      extensions: ["builtin:tool-search", path.join(root, "tests/fixtures/app-renewal.ts")],
      tools: ["app_renewal_fixture", "tool_search"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "discover",
              name: "tool_search",
              arguments: { query: "linear read", limit: 8 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([toolCall({ id: "status", name: "app_renewal_fixture", arguments: {} })], {
          stopReason: "toolUse",
        }),
        assistantMessage(
          [
            toolCall({
              id: "read",
              name: "linear_read",
              arguments: { path: `linear://example/document/${documentId}/content` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Synthetic App renewal completed.")]),
      ],
    }).run(
      "Use only the isolated local synthetic service. Inspect the saved App and read its fixture document.",
    );
    for (const id of ["discover", "status", "read"])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    expect(JSON.parse(getToolResultText(result, "status"))).toMatchObject({
      selection: { connectionId: connected.connectionId },
      status: {
        connectionId: connected.connectionId,
        epoch: connected.epoch,
        state: "connected",
        actor: "app",
        capabilities: { refresh: true },
      },
    });
    expect(getToolResultText(result, "read")).toContain(document.content);
    expect(result.tuiRenderedOutput).toContain(viewer.name);
    expect(result.tuiRenderedOutput).toContain(viewer.organization.name);
    const exchanges = requests.filter((request) => request.url === "/oauth/token");
    expect(exchanges).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(exchanges[0].body))).toEqual({
      grant_type: "client_credentials",
      client_id: "synthetic-pi-app-client",
      client_secret: clientSecret,
      scope: scope.join(","),
    });
    const reads = requests.filter(
      (request) => request.url === "/mcp" && request.body.includes('"tools/call"'),
    );
    expect(reads).toHaveLength(1);
    expect(reads[0].authorization).toBe(`Bearer ${newToken}`);
    expect(await readFile(connectionFile + ".profiles.json", "utf8")).toBe(catalog);
    expect(await readFile(cacheFile, "utf8")).toBe(cache);
    expect(JSON.parse(await readFile(grantFile, "utf8"))).toMatchObject({
      credential: { accessToken: newToken },
    });
    for (const secret of [oldToken, newToken, clientSecret]) {
      expect(result.terminalOutput).not.toContain(secret);
      expect(JSON.stringify(result.messages)).not.toContain(secret);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
  expect(fixtureFailure).toBeUndefined();
}, 120_000);
