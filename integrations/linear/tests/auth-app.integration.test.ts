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

test("App sign-in carries the selected permissions through real Pi and the production OAuth backend", async () => {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/auth-app-"));
  const scope = ["read", "write", "comments:create", "app:assignable"];
  let exchanges = 0;
  let fixtureFailure: unknown;
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url === "/oauth/token") {
      expect(new URLSearchParams(body).get("grant_type")).toBe("authorization_code");
      exchanges++;
      response.end(
        JSON.stringify({
          access_token: "synthetic-private-app-token",
          token_type: "Bearer",
          scope: scope.join(" "),
        }),
      );
    } else {
      expect(request.headers.authorization).toBe("Bearer synthetic-private-app-token");
      response.end(
        JSON.stringify({
          data: {
            viewer: {
              id: "fixture-app",
              name: "Synthetic app actor",
              app: true,
              organization: {
                id: "fixture-workspace",
                name: "Fixture workspace",
                urlKey: "example",
              },
            },
          },
        }),
      );
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
  // A separate callback port belongs to the actual CLI listener.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const callbackPort = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  try {
    await mkdir(path.join(cwd, ".pi"));
    await mkdir(path.join(cwd, "bin"));
    await writeFile(
      path.join(cwd, ".pi/linear.json"),
      JSON.stringify({ axiPath: path.join(root, "packages/linear-axi/src/bin.ts") }),
    );
    await writeFile(
      path.join(cwd, "bin/xdg-open"),
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nconst url = new URL(process.argv[2]);\nwriteFileSync(${JSON.stringify(path.join(cwd, "consent.json"))}, JSON.stringify({actor:url.searchParams.get('actor'), scopes:url.searchParams.get('scope')?.split(',')}));\nconst callback=new URL(url.searchParams.get('redirect_uri'));\ncallback.searchParams.set('state',url.searchParams.get('state'));\ncallback.searchParams.set('code','synthetic-code');\nconst response=await fetch(callback); if(!response.ok) process.exit(2);\n`,
      { mode: 0o700 },
    );
    const run = await new PiIntegrationTest({
      testName: "linear-app-scope-consent",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      timeoutMs: 45_000,
      environment: {
        PATH: path.join(cwd, "bin") + path.delimiter + (process.env.PATH ?? ""),
        LINEAR_AXI_CONNECTION_FILE: path.join(cwd, "connection.json"),
        LINEAR_AXI_CONNECTION_ID: "none",
        LINEAR_AXI_OAUTH_CLIENT_ID: "fixture-public-client",
        LINEAR_AXI_OAUTH_REDIRECT_URI: `http://127.0.0.1:${callbackPort}/oauth/callback`,
        LINEAR_AXI_OAUTH_TOKEN_URL: address + "/oauth/token",
        LINEAR_AXI_GRAPHQL_URL: address + "/graphql",
      },
      extensions: [path.join(root, "tests/fixtures/auth-app.ts")],
      tools: ["auth_app_fixture"],
      conversation: [
        assistantMessage([toolCall({ id: "app-login", name: "auth_app_fixture", arguments: {} })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Finished App authorization checks.")]),
      ],
    }).run("Use only the local synthetic OAuth service. Never authorize a real Linear account.");
    expect(getToolExecution(run, "app-login").isError, getToolResultText(run, "app-login")).toBe(
      false,
    );
    expect(JSON.parse(await readFile(path.join(cwd, "consent.json"), "utf8"))).toEqual({
      actor: "app",
      scopes: scope,
    });
    expect(exchanges).toBe(1);
    expect(run.tuiRenderedOutput).toContain("Synthetic app actor");
    for (const item of scope) expect(run.tuiRenderedOutput).toContain(item);
    expect(JSON.stringify(run.messages)).not.toContain("synthetic-private-app-token");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
  expect(fixtureFailure).toBeUndefined();
}, 60_000);
