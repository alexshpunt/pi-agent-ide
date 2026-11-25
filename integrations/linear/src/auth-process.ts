import { execFile } from "node:child_process";
import { AXI_WORKER_OUTPUT_TOO_LARGE, runAxiWorker, type AxiWorkerOutput } from "./axi-worker.ts";
import { axiPath } from "./config.ts";
import { authorizationUrl } from "./auth-browser.ts";

export const APP_AUTH_SCOPES = "read,write,comments:create,app:assignable";
export type AuthMethod = "mcp-oauth" | "user-oauth" | "app-oauth" | "api-key" | "oauth-token";
export const isConnectionId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
export interface AuthConnection {
  readonly connectionId: string;
  readonly name: string;
  readonly method: AuthMethod;
  readonly state: AuthStatus["state"];
  readonly credentialType?: AuthStatus["credentialType"];
  readonly actor?: AuthStatus["actor"];
  readonly identity?: AuthStatus["identity"];
  readonly scopes?: AuthStatus["scopes"];
  readonly capabilities?: AuthStatus["capabilities"];
}
export interface AuthStatus {
  readonly connectionId?: string;
  readonly name?: string;
  readonly method?: AuthMethod;
  readonly defaultConnectionId?: string | null;
  readonly connections?: readonly AuthConnection[];
  readonly state: "legacy" | "signed-out" | "connected" | "expired" | "error";
  readonly epoch: string;
  readonly credentialType?: "oauth" | "api-key";
  readonly actor?: "user" | "app";
  readonly identity?: {
    readonly id: string;
    readonly name: string;
    readonly email?: string;
    readonly workspace: { readonly id: string; readonly slug: string; readonly name: string };
  };
  readonly scopes?: readonly string[];
  readonly capabilities?: {
    readonly mcp: boolean;
    readonly native: boolean;
    readonly storage: boolean;
    readonly refresh: boolean;
    readonly revoke: boolean;
  };
}
export interface AuthRunOptions {
  readonly expectedEpoch?: string;
  readonly connectionId?: string;
  readonly signal?: AbortSignal;
  readonly input?: {
    readonly type: "api-key" | "oauth";
    readonly token: string;
    readonly name?: string;
  };
  readonly onAuthorization?: (url: string) => void;
}
export type AuthRunner = (
  cwd: string,
  args: readonly string[],
  options?: AuthRunOptions,
) => Promise<AuthStatus>;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
const safeText = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 500 &&
  !/[\x00-\x1f\x7f-\x9f]/u.test(value)
    ? value
    : undefined;
function isAuthState(value: unknown): value is AuthStatus["state"] {
  return (
    value === "legacy" ||
    value === "signed-out" ||
    value === "connected" ||
    value === "expired" ||
    value === "error"
  );
}
function isAuthMethod(value: unknown): value is AuthMethod {
  return (
    value === "mcp-oauth" ||
    value === "user-oauth" ||
    value === "app-oauth" ||
    value === "api-key" ||
    value === "oauth-token"
  );
}
function status(value: unknown, summary = false): AuthStatus {
  const row = object(value);
  const epoch = safeText(row?.epoch);
  if (!row || !isAuthState(row.state) || !epoch) throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
  const data: { -readonly [K in keyof AuthStatus]: AuthStatus[K] } = {
    state: row.state,
    epoch,
  };
  if (row.connectionId !== undefined) {
    if (!isConnectionId(row.connectionId)) throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
    data.connectionId = row.connectionId;
  }
  if (row.name !== undefined) {
    const name = safeText(row.name);
    if (!name || name.length > 120) throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
    data.name = name;
  }
  if (row.method !== undefined) {
    if (!isAuthMethod(row.method)) throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
    data.method = row.method;
  }
  if (row.defaultConnectionId !== undefined) {
    if (row.defaultConnectionId !== null && !isConnectionId(row.defaultConnectionId))
      throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
    data.defaultConnectionId = row.defaultConnectionId;
  }
  if (!summary && row.connections !== undefined) {
    if (!Array.isArray(row.connections) || row.connections.length > 1000)
      throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
    data.connections = row.connections.map((item): AuthConnection => {
      const record = object(item);
      if (!record) throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
      const parsed = status({ ...record, epoch: record.epoch ?? "summary" }, true);
      if (
        !parsed.connectionId ||
        !parsed.name ||
        !parsed.method ||
        (parsed.state === "connected" && (!parsed.identity || !parsed.credentialType))
      )
        throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
      const {
        connectionId,
        name,
        method,
        state,
        credentialType,
        actor,
        identity,
        scopes,
        capabilities,
      } = parsed;
      return {
        connectionId,
        name,
        method,
        state,
        credentialType,
        actor,
        identity,
        scopes,
        capabilities,
      };
    });
  }
  if (row.credentialType === "oauth" || row.credentialType === "api-key")
    data.credentialType = row.credentialType;
  if (row.actor === "user" || row.actor === "app") data.actor = row.actor;
  const identity = object(row.identity);
  const workspace = object(identity?.workspace);
  const id = safeText(identity?.id);
  const name = safeText(identity?.name);
  const email = safeText(identity?.email);
  const workspaceId = safeText(workspace?.id);
  const workspaceSlug = safeText(workspace?.slug);
  const workspaceName = safeText(workspace?.name);
  if (id && name && workspaceId && workspaceSlug && workspaceName) {
    data.identity = {
      id,
      name,
      ...(email ? { email } : {}),
      workspace: { id: workspaceId, slug: workspaceSlug, name: workspaceName },
    };
  }
  const scopes: unknown = row.scopes;
  if (
    Array.isArray(scopes) &&
    scopes.length <= 50 &&
    scopes.every(
      (item: unknown): item is string =>
        typeof item === "string" && /^[A-Za-z][A-Za-z:_-]*$/u.test(item),
    )
  )
    data.scopes = [...scopes];
  const capabilities = object(row.capabilities);
  if (capabilities) {
    const { mcp, native, storage, refresh, revoke } = capabilities;
    if (
      typeof mcp === "boolean" &&
      typeof native === "boolean" &&
      typeof storage === "boolean" &&
      typeof refresh === "boolean" &&
      typeof revoke === "boolean"
    )
      data.capabilities = { mcp, native, storage, refresh, revoke };
  }
  return data;
}
function validName(value: unknown): boolean {
  const name = safeText(value);
  return name !== undefined && name.length <= 120 && name.trim().length > 0;
}
function validCommand(args: readonly string[]): boolean {
  const [action, ...rest] = args;
  if (!action) return false;
  if (action === "revoke")
    return rest.length === 0 || (rest.length === 1 && rest[0] === "--forget-on-refusal");
  if (["status", "epoch", "list", "import", "logout"].includes(action)) return rest.length === 0;
  if (action === "select" || action === "default")
    return (
      rest.length === 2 &&
      rest[0] === "--id" &&
      (isConnectionId(rest[1]) || (action === "default" && rest[1] === "none"))
    );
  if (action === "rename")
    return (
      rest.length === 4 &&
      rest[0] === "--id" &&
      isConnectionId(rest[1]) &&
      rest[2] === "--name" &&
      validName(rest[3])
    );
  if (action === "connect-app")
    return rest.length === 2 && rest[0] === "--name" && validName(rest[1]);
  if (action !== "login") return false;
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (seen.has(flag)) return false;
    seen.add(flag);
    if (flag === "--manual") continue;
    const value = rest.at(++index);
    if (value === undefined) return false;
    if (flag === "--actor" && (value === "user" || value === "app")) continue;
    if (flag === "--scope" && ["read", "read,write", APP_AUTH_SCOPES].includes(value)) continue;
    if (flag === "--method" && (value === "mcp" || value === "oauth")) continue;
    if (flag === "--name" && validName(value)) continue;
    return false;
  }
  return (
    rest[rest.indexOf("--scope") + 1] !== APP_AUTH_SCOPES ||
    (rest[rest.indexOf("--actor") + 1] === "app" && rest[rest.indexOf("--method") + 1] === "oauth")
  );
}
/** Read the auth protocol's JSON lines: authorization events, one status, or one error. */
function authOutput(args: readonly string[], options: AuthRunOptions) {
  let result: AuthStatus | undefined;
  let protocolError: Error | undefined;
  return {
    get result() {
      return result;
    },
    get protocolError() {
      return protocolError;
    },
    overflow() {
      protocolError = new Error("LINEAR_AUTH_INVALID_RESPONSE");
    },
    /** False when the line breaks the protocol; the command must then be stopped. */
    consume(line: string): boolean {
      if (!line.trim() || protocolError) return true;
      try {
        const value = object(JSON.parse(line));
        const errorCode = value?.error ?? value?.code;
        if (value?.event === "authorization")
          options.onAuthorization?.(authorizationUrl(value.url));
        else if (
          value?.event === "error" &&
          typeof errorCode === "string" &&
          /^LINEAR_[A-Z0-9_]+$/u.test(errorCode)
        )
          protocolError = new Error(errorCode);
        else {
          if (result) throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
          result = status(value);
          if (
            args[0] !== "epoch" &&
            result.state === "connected" &&
            (!result.identity || !result.credentialType)
          )
            throw new Error("LINEAR_AUTH_INVALID_RESPONSE");
        }
        return true;
      } catch {
        protocolError ??= new Error("LINEAR_AUTH_INVALID_RESPONSE");
        return false;
      }
    },
  };
}
/** Keep secret input on stdin and expose only the backend's bounded, allowlisted auth protocol. */
export function createAuthRunner(
  resolveExecutable: (cwd: string) => Promise<string> = axiPath,
): AuthRunner {
  return async (cwd, args, options = {}) => {
    if (options.signal?.aborted) throw new Error("LINEAR_AUTH_CANCELLED");
    if (
      !validCommand(args) ||
      (options.connectionId !== undefined &&
        options.connectionId !== "none" &&
        !isConnectionId(options.connectionId))
    )
      throw new Error("LINEAR_AUTH_INVALID_COMMAND");
    const executable = await resolveExecutable(cwd);
    if (options.signal?.aborted) throw new Error("LINEAR_AUTH_CANCELLED");
    const javascript = /\.[cm]?js$/u.test(executable);
    const environment = { ...process.env };
    delete environment.LINEAR_AXI_AUTH_EPOCH;
    delete environment.LINEAR_AXI_CONNECTION_ID;
    if (options.connectionId !== undefined)
      environment.LINEAR_AXI_CONNECTION_ID = options.connectionId;
    if (options.expectedEpoch !== undefined) {
      if (!["revoke", "logout"].includes(args[0]) || !safeText(options.expectedEpoch))
        throw new Error("LINEAR_AUTH_INVALID_COMMAND");
      environment.LINEAR_AXI_AUTH_EPOCH = options.expectedEpoch;
    }
    const revoking = args[0] === "revoke";
    const output = authOutput(args, options);
    // Settle like the one-shot CLI: a protocol error wins, then a failed or cancelled
    // command, then a missing status.
    const settle = (failure?: { code?: unknown }): AuthStatus => {
      if (output.protocolError)
        throw new Error(
          revoking && output.protocolError.message === "LINEAR_AUTH_INVALID_RESPONSE"
            ? "LINEAR_AUTH_REVOKE_UNKNOWN"
            : output.protocolError.message,
        );
      if (failure || options.signal?.aborted)
        throw new Error(
          failure?.code === "ENOENT"
            ? "LINEAR_AXI_NOT_FOUND"
            : revoking
              ? "LINEAR_AUTH_REVOKE_UNKNOWN"
              : options.signal?.aborted
                ? "LINEAR_AUTH_CANCELLED"
                : "LINEAR_AUTH_COMMAND_FAILED",
        );
      if (!output.result)
        throw new Error(revoking ? "LINEAR_AUTH_REVOKE_UNKNOWN" : "LINEAR_AUTH_INVALID_RESPONSE");
      return output.result;
    };
    // Status reads need neither stdin, an expected epoch nor a browser, so they run in the
    // backend's worker when it has one. They happen around every typed Linear operation.
    if (
      ["epoch", "status", "list"].includes(args[0]) &&
      !options.input &&
      !options.onAuthorization &&
      options.expectedEpoch === undefined
    ) {
      let reply: AxiWorkerOutput | undefined;
      try {
        reply = await runAxiWorker(executable, cwd, ["auth", ...args, "--json"], environment, {
          signal: options.signal,
          timeoutMs: 30_000,
          maxBytes: 256 * 1024,
        });
      } catch (error) {
        if (error instanceof Error && error.message === AXI_WORKER_OUTPUT_TOO_LARGE)
          throw new Error("LINEAR_AUTH_INVALID_RESPONSE", { cause: error });
        return settle({});
      }
      if (reply) {
        for (const line of reply.stdout.split("\n")) if (!output.consume(line)) break;
        return settle(reply.exitCode === 0 ? undefined : {});
      }
    }
    const failure = await new Promise<{ code?: unknown } | undefined>((resolve) => {
      let buffer = "",
        bytes = 0;
      const child = execFile(
        javascript ? process.execPath : executable,
        [...(javascript ? [executable] : []), "auth", ...args, "--json"],
        {
          cwd,
          env: environment,
          signal: options.signal,
          timeout: args[0] === "login" ? 125_000 : 30_000,
          maxBuffer: 256 * 1024,
          encoding: "utf8",
        },
        (error) => {
          if (buffer.trim() && !output.protocolError) output.consume(buffer);
          resolve(error ?? undefined);
        },
      );
      function consume(line: string) {
        if (!output.consume(line)) child.kill();
      }
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 256 * 1024) {
          output.overflow();
          child.kill();
          return;
        }
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) consume(line);
      });
      // Neither stderr nor raw process errors are forwarded: they may contain a credential.
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input ? JSON.stringify(options.input) : "");
    });
    return settle(failure);
  };
}
export const runAuthCommand = createAuthRunner();
export async function readAuthEpoch(
  cwd: string,
  signal?: AbortSignal,
  connectionId?: string,
): Promise<{ epoch: string; state: string; connectionId?: string }> {
  const value = await runAuthCommand(cwd, ["epoch"], { signal, connectionId });
  return { epoch: value.epoch, state: value.state, connectionId: value.connectionId };
}
