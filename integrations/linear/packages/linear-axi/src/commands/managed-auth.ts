import { createServer } from "node:http";
import type { Readable } from "node:stream";
import { parseFlags } from "#axi/args.ts";
import type { ConnectionStatus, ManagedConnection } from "#axi/managed-connection.ts";
import { NamedConnections } from "#axi/named-connections.ts";
import { asRecord, isRecord } from "#axi/types.ts";
import { optionalText } from "./command-input.ts";

/** JSON auth errors contain a closed identifier, never a remote body or credential. */
export class ManagedAuthError extends Error {
  readonly effect?: "unknown";
  constructor(error: unknown) {
    const code =
      error instanceof Error && /^LINEAR_(?:AUTH|OAUTH)_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "LINEAR_AUTH_FAILED";
    super(code);
    this.effect = code === "LINEAR_AUTH_REVOKE_UNKNOWN" ? "unknown" : undefined;
  }
}
async function secretInput(stream: Readable): Promise<Record<string, unknown>> {
  if ((stream as Readable & { isTTY?: boolean }).isTTY)
    throw new Error("LINEAR_AUTH_SECRET_INPUT_REQUIRED");
  let input = "";
  for await (const chunk of stream) {
    if (typeof chunk === "string") input += chunk;
    else if (Buffer.isBuffer(chunk)) input += chunk.toString("utf8");
    else throw new Error("LINEAR_AUTH_INPUT_INVALID");
    if (Buffer.byteLength(input) > 65536) throw new Error("LINEAR_AUTH_INPUT_INVALID");
  }
  try {
    const value: unknown = JSON.parse(input);
    if (!isRecord(value)) throw new Error();
    return value;
  } catch {
    throw new Error("LINEAR_AUTH_INPUT_INVALID");
  }
}
function flags(args: string[]) {
  const allowed = new Set([
    "--json",
    "--actor",
    "--scope",
    "--manual",
    "--forget-on-refusal",
    "--timeout",
    "--id",
    "--name",
    "--method",
  ]);
  for (const arg of args)
    if (arg.startsWith("--") && !allowed.has(arg.split("=")[0]))
      throw new Error("LINEAR_AUTH_INPUT_INVALID");
  const parsed = parseFlags(args, { boolean: ["json", "manual", "forget-on-refusal"] });
  if (parsed.positionals.length) throw new Error("LINEAR_AUTH_INPUT_INVALID");
  return parsed;
}
export async function managedAuthCommand(
  args: string[],
  runtime: {
    env: NodeJS.ProcessEnv;
    connection?: ManagedConnection;
    stdin?: Readable;
    stdout?: { write(value: string): unknown };
  },
): Promise<string> {
  try {
    const [action, ...rest] = args;
    const parsed = flags(rest);
    if (parsed["forget-on-refusal"] && action !== "revoke")
      throw new Error("LINEAR_AUTH_INPUT_INVALID");
    const connection = runtime.connection ?? new NamedConnections({ env: runtime.env });
    switch (action) {
      case "list":
      case "select":
      case "rename":
      case "default": {
        if (!(connection instanceof NamedConnections)) throw new Error("LINEAR_AUTH_INPUT_INVALID");
        if (action === "list") return JSON.stringify(await connection.list());
        if (typeof parsed.id !== "string") throw new Error("LINEAR_AUTH_INPUT_INVALID");
        if (action === "select") return JSON.stringify(await connection.select(parsed.id));
        if (action === "default")
          return JSON.stringify(
            await connection.setDefault(parsed.id === "none" ? null : parsed.id),
          );
        if (typeof parsed.name !== "string") throw new Error("LINEAR_AUTH_INPUT_INVALID");
        return JSON.stringify(await connection.rename(parsed.id, parsed.name));
      }
      case "connect-app": {
        if (!(connection instanceof NamedConnections)) throw new Error("LINEAR_AUTH_INPUT_INVALID");
        return JSON.stringify(
          await connection.connectInstalledApp({ name: optionalText(parsed.name) }),
        );
      }
      case "enable-app-renewal": {
        if (typeof parsed.scope !== "string") throw new Error("LINEAR_AUTH_APP_RENEWAL_CONFIG");
        return JSON.stringify(
          await connection.enableAppRenewal(parsed.scope.split(/[ ,]+/u).filter(Boolean)),
        );
      }
      case "status": {
        return JSON.stringify(await connection.status(true));
      }
      case "epoch": {
        return JSON.stringify(await connection.epoch());
      }
      case "logout": {
        return JSON.stringify(await connection.logout());
      }
      case "revoke": {
        return JSON.stringify(
          await connection.revoke({ forgetOnRefusal: !!parsed["forget-on-refusal"] }),
        );
      }
      case "import": {
        const input = await secretInput(runtime.stdin ?? process.stdin);
        if (
          Object.keys(input).some((k) => !["type", "token", "name"].includes(k)) ||
          (input.name !== undefined && typeof input.name !== "string") ||
          (input.type !== "api-key" && input.type !== "oauth") ||
          typeof input.token !== "string"
        )
          throw new Error("LINEAR_AUTH_INPUT_INVALID");
        const credential: Parameters<typeof connection.importCredential>[0] = {
          type: input.type,
          token: input.token,
          ...(input.name !== undefined ? { name: input.name } : {}),
        };
        return JSON.stringify(await connection.importCredential(credential));
      }
      case "finish": {
        const input = await secretInput(runtime.stdin ?? process.stdin);
        if (
          Object.keys(input).some((k) => k !== "callbackUrl") ||
          typeof input.callbackUrl !== "string"
        )
          throw new Error("LINEAR_AUTH_INPUT_INVALID");
        return JSON.stringify(await connection.finishLogin({ callbackUrl: input.callbackUrl }));
      }
      case "login": {
        const actor = parsed.actor ?? "user";
        if (actor !== "user" && actor !== "app") throw new Error("LINEAR_AUTH_INPUT_INVALID");
        const timeout = Number(parsed.timeout ?? 120000);
        if (!Number.isFinite(timeout) || timeout < 100 || timeout > 300000)
          throw new Error("LINEAR_AUTH_INPUT_INVALID");
        const method = parsed.method;
        if (method !== undefined && method !== "mcp" && method !== "oauth")
          throw new Error("LINEAR_AUTH_INPUT_INVALID");
        const scope = optionalText(parsed.scope);
        const name = optionalText(parsed.name);
        const login = {
          actor,
          ...(scope === undefined ? {} : { scopes: scope.split(",") }),
          ...(name === undefined ? {} : { name }),
          ...(method === undefined ? {} : { method }),
        } satisfies Parameters<typeof connection.beginLogin>[0];
        const start = await connection.beginLogin(login);
        const event = {
          event: "authorization",
          ...start,
          ...(parsed.manual ? { pending: true } : {}),
        };
        if (parsed.manual) return JSON.stringify(event);
        try {
          const status = await callbackLogin(connection, start, timeout, () =>
            runtime.stdout?.write(JSON.stringify(event) + "\n"),
          );
          return JSON.stringify({ event: "result", ...status });
        } catch (error) {
          await connection.cancelLogin(start.epoch);
          throw error;
        }
      }
      default: {
        throw new Error("LINEAR_AUTH_INPUT_INVALID");
      }
    }
  } catch (error) {
    throw new ManagedAuthError(error);
  }
}
async function callbackLogin(
  connection: ManagedConnection,
  start: { url: string; epoch: string; redirectUri: string },
  timeout: number,
  announce: () => void,
): Promise<ConnectionStatus> {
  const callback = new URL(start.redirectUri);
  const { promise: result, resolve: settle, reject } = Promise.withResolvers<ConnectionStatus>();
  let handled = false;
  const server = createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", callback.origin);
    } catch {
      response.writeHead(400).end("Invalid callback.");
      return;
    }
    if (url.pathname !== callback.pathname) {
      response.writeHead(404).end("Not found.");
      return;
    }
    if (handled) {
      response.writeHead(409).end("This login has already finished.");
      return;
    }
    // Ignore an unrelated loopback request without consuming the real pending login.
    if (url.searchParams.get("state") !== new URL(start.url).searchParams.get("state")) {
      response.writeHead(400).end("OAuth state did not match.");
      return;
    }
    handled = true;
    const finish = connection.finishLogin({ callbackUrl: url.href });
    void finish.then(
      () =>
        response
          .writeHead(200, { "content-type": "text/plain" })
          .end("Linear connected. You can close this tab."),
      () =>
        response
          .writeHead(400, { "content-type": "text/plain" })
          .end("Linear sign-in failed. Return to Pi for the result."),
    );
    settle(finish);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, fail) => {
      server.once("error", fail);
      server.listen(
        Number(callback.port || 80),
        callback.hostname.replace(/^\[|\]$/gu, ""),
        resolve,
      );
    });
    timer = setTimeout(() => reject(new Error("LINEAR_AUTH_CALLBACK_TIMEOUT")), timeout);
    announce();
    return await result;
  } catch (error) {
    if (asRecord(error)?.code === "EADDRINUSE")
      throw new Error("LINEAR_AUTH_CALLBACK_BUSY", { cause: error });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    server.closeIdleConnections();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
}
