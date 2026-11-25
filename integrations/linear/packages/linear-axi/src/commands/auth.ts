import { createServer } from "node:http";
import { parseFlags, usage } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import { dispatchCommandGroup, parseFiniteNumber } from "#axi/lib/cli-helpers.ts";
import {
  authFinishHelp,
  authLoginHelp,
  authLogoutHelp,
  groupHelp,
  managedAuthHelp,
} from "./help.ts";
import { managedAuthCommand } from "./managed-auth.ts";
import type { McpClientLike, ParsedFlags } from "#axi/types.ts";

type AuthRuntime = Parameters<typeof managedAuthCommand>[1] & { client?: McpClientLike };
type LegacyAuthRuntime = AuthRuntime & { client: McpClientLike };

export async function authCommand(args: string[], runtime: AuthRuntime) {
  if (runtime.connection || args.includes("--json")) {
    if (!args.length || args.includes("--help") || args.includes("-h")) return managedAuthHelp();
    const output = await managedAuthCommand(args, runtime);
    if (args.includes("--json")) return output;
    const event: unknown = JSON.parse(output);
    return renderToon(event);
  }
  if (!runtime.client) throw usage("Legacy MCP authorization client is unavailable", []);
  const legacy: LegacyAuthRuntime = { ...runtime, client: runtime.client };
  return dispatchCommandGroup(args, {
    name: "auth",
    help: () => groupHelp("auth", ["login", "finish", "logout"]),
    handlers: {
      login: (rest: string[]) => loginCommand(rest, legacy),
      finish: (rest: string[]) => finishCommand(rest, legacy),
      logout: (rest: string[]) => logoutCommand(rest, legacy),
    },
    unknownHelp: [
      "Run `linear-axi auth login`",
      "Run `linear-axi auth finish --code <code>`",
      "Run `linear-axi auth logout`",
    ],
  });
}

async function loginCommand(args: string[], runtime: LegacyAuthRuntime) {
  const parsed = parseFlags(args, { boolean: ["help", "manual"], example: "auth login" });
  if (parsed.help) return authLoginHelp();
  try {
    await runtime.client.listTools();
    return renderToon({ auth: "Linear MCP OAuth already authorized" });
  } catch (error) {
    const authorizationUrl = authUrl(error);
    if (authorizationUrl) {
      if (parsed.manual) {
        return renderToon({
          auth: "Linear MCP OAuth authorization required",
          url: authorizationUrl,
          help: ["Open the URL, copy the code, then run `linear-axi auth finish --code <code>`"],
        });
      }

      return completeLoginWithCallback(authorizationUrl, runtime, parsed);
    }
    throw error;
  }
}

async function finishCommand(args: string[], runtime: LegacyAuthRuntime) {
  const parsed = parseFlags(args, { boolean: ["help"], example: "auth finish --code <code>" });
  if (parsed.help) return authFinishHelp();
  const { code } = parsed;
  if (typeof code !== "string" || !code)
    throw usage("--code is required", ["Run `linear-axi auth finish --code <code>`"]);
  if (!runtime.client.finishAuth) throw usage("Legacy OAuth completion is unavailable", []);
  await runtime.client.finishAuth(code);
  return renderToon({ auth: "Linear MCP OAuth authorized" });
}

async function logoutCommand(args: string[], runtime: LegacyAuthRuntime) {
  const parsed = parseFlags(args, { boolean: ["help"], example: "auth logout" });
  if (parsed.help) return authLogoutHelp();
  if (runtime.connection) {
    const status = await runtime.connection.logout();
    return renderToon({ auth: "Linear connection signed out locally", ...status });
  }
  if (!runtime.client.logoutAuth) throw usage("Legacy OAuth logout is unavailable", []);
  const result = await runtime.client.logoutAuth();
  const auth = result.removed
    ? "Linear MCP OAuth credentials cleared"
    : "Linear MCP OAuth credentials already absent";
  return renderToon({
    auth,
    ...(result.tokenConfigured
      ? { note: "LINEAR_AXI_MCP_TOKEN or LINEAR_MCP_TOKEN remains configured" }
      : {}),
  });
}

async function completeLoginWithCallback(
  authorizationUrl: string,
  runtime: LegacyAuthRuntime,
  parsed: ParsedFlags,
) {
  const timeoutMs = parseFiniteNumber("timeout", parsed.timeout ?? 300000);
  const callbackUrl = new URL("http://127.0.0.1:14566/oauth/callback");
  const expectedState = new URL(authorizationUrl).searchParams.get("state");
  if (!expectedState) {
    throw usage("OAuth authorization URL did not include state", [
      "Run `linear-axi auth login --manual`",
    ]);
  }
  const server = await startOAuthCallbackServer(callbackUrl, timeoutMs, expectedState);

  runtime.stdout?.write(
    renderToon({
      auth: "Linear MCP OAuth authorization required",
      url: authorizationUrl,
      callback: callbackUrl.toString(),
      help: [
        "Open the URL in a browser to finish automatically",
        "If callback capture fails, rerun `linear-axi auth login --manual`",
      ],
    }),
  );

  try {
    const code = await server.code;
    if (!runtime.client.finishAuth) throw usage("Legacy OAuth completion is unavailable", []);
    await runtime.client.finishAuth(code);
    return renderToon({ auth: "Linear MCP OAuth authorized" });
  } finally {
    await server.close();
  }
}

async function startOAuthCallbackServer(
  callbackUrl: URL,
  timeoutMs: number,
  expectedState: string,
) {
  if (callbackUrl.hostname !== "127.0.0.1" && callbackUrl.hostname !== "localhost") {
    throw usage("OAuth callback must use localhost or 127.0.0.1", [
      "Run `linear-axi auth login --manual`",
    ]);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const {
    promise: code,
    resolve: resolveCode,
    reject: rejectCode,
  } = Promise.withResolvers<string>();

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", callbackUrl.origin);
    if (requestUrl.pathname !== callbackUrl.pathname) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found.\n");
      return;
    }

    const error = requestUrl.searchParams.get("error");
    const authCode = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    if (state !== expectedState) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("OAuth state did not match. You can close this tab.\n");
      return;
    }
    if (error) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Linear authorization failed. You can close this tab.\n");
      finish(new Error(`Linear OAuth error: ${error}`), undefined);
      return;
    }
    if (!authCode) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Missing OAuth code. You can close this tab.\n");
      finish(new Error("Linear OAuth callback did not include a code"), undefined);
      return;
    }

    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Linear authorization captured. You can close this tab.\n");
    finish(null, authCode);
  });

  function finish(error: Error | null, authCode?: string) {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) rejectCode(error);
    else if (authCode !== undefined) resolveCode(authCode);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(callbackUrl.port || 80), callbackUrl.hostname, () => resolve());
  });

  timeout = setTimeout(() => {
    finish(new Error("Timed out waiting for Linear OAuth callback"), undefined);
  }, timeoutMs);

  return {
    code,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function authUrl(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("authorizationUrl" in error)) return null;
  return typeof error.authorizationUrl === "string" ? error.authorizationUrl : null;
}
