import { realpathSync } from "node:fs";
import manifest from "#axi-package" with { type: "json" };
import { AxiError as SdkAxiError, exitCodeForError, runAxiCli } from "axi-sdk-js";
import { usage } from "./args.ts";
import { loadDotEnv, resolveMcpUrl } from "./config.ts";
import { renderToon } from "./format.ts";
import { LinearMcpClient } from "./mcp.ts";
import { NamedConnections } from "./named-connections.ts";
import { LinearPreflightCache } from "./preflight-cache.ts";
import { rateLimitInfoFromError } from "./rate-limit.ts";
import { ResourceOperationFailure } from "./lib/resource-failure.ts";
import { ManagedAuthError } from "./commands/managed-auth.ts";
import { LinearAppTokenProvider } from "./app-token.ts";
import { LinearGraphqlClient } from "./graphql.ts";
import { authCommand } from "./commands/auth.ts";
import { commentCommand } from "./commands/comments.ts";
import { cycleCommand } from "./commands/cycles.ts";
import { documentCommand } from "./commands/documents.ts";
import { topHelp } from "./commands/help.ts";
import { homeCommand } from "./commands/home.ts";
import { initCommand } from "./commands/init.ts";
import { issueCommand } from "./commands/issues.ts";
import { listResourceCommand } from "./commands/list-resource.ts";
import { milestoneCommand } from "./commands/milestones.ts";
import { projectCommand } from "./commands/projects.ts";
import { LIST_TOOL_ALIASES, normalizeError } from "./commands/shared.ts";
import { statusCommand } from "./commands/statuses.ts";
import { searchCommand } from "./commands/search.ts";
import { resourceCommand } from "./commands/resources.ts";
import { assetCommand } from "./commands/assets.ts";
import { apiCommand } from "./commands/api.ts";
import { RawGraphqlInputError } from "./native-raw-graphql.ts";
import { LinearStorageClient } from "./storage.ts";
import { DESCRIPTION } from "./skill.ts";

import { isUnknownArray, type MainContext, type Renderable, type Runtime } from "./types.ts";
import { valueText } from "./lib/value-text.ts";

const { version: VERSION } = manifest;
type Command = (args: string[], runtime: Runtime) => string | Promise<string>;

const COMMANDS: Readonly<Record<string, Command | undefined>> = {
  ...Object.fromEntries(
    Object.keys(LIST_TOOL_ALIASES).map((command) => [
      command,
      (args: string[], runtime: Runtime) => listResourceCommand(command, args, runtime),
    ]),
  ),
  init: initCommand,
  search: searchCommand,
  resources: resourceCommand,
  assets: assetCommand,
  api: apiCommand,
  auth: authCommand,
  issues: issueCommand,
  issue: issueCommand,
  comments: commentCommand,
  comment: commentCommand,
  milestones: milestoneCommand,
  milestone: milestoneCommand,
  cycles: cycleCommand,
  cycle: cycleCommand,
  statuses: statusCommand,
  status: statusCommand,
  documents: documentCommand,
  document: documentCommand,
  projects: projectCommand,
  project: projectCommand,
};

export async function main(args: string[], context: MainContext): Promise<void> {
  await runAxiCli(cliOptions(args, context));
}

/** Whether `runCommand` can run these arguments without touching process-wide state. */
export function isWorkerCommand(args: unknown): args is string[] {
  return (
    isUnknownArray(args) &&
    typeof args[0] === "string" &&
    args.every((arg) => typeof arg === "string") &&
    Object.hasOwn(COMMANDS, args[0])
  );
}

/**
 * Run one registered command and return its exit code instead of setting `process.exitCode`,
 * so several commands can share one process. The SDK assigns `process.exitCode` itself only
 * for help, version, leading-flag and unknown-command input, which `isWorkerCommand` rejects.
 */
export async function runCommand(args: string[], context: MainContext): Promise<number> {
  if (!isWorkerCommand(args)) throw new Error("LINEAR_AXI_UNSUPPORTED_COMMAND");
  let exitCode = 0;
  const options = cliOptions(args, context);
  try {
    await runAxiCli({
      ...options,
      formatError(error) {
        const formatted = options.formatError(error);
        exitCode = formatted.exitCode;
        return formatted;
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : valueText(error);
    context.stdout.write(`error: ${message}\n`);
    context.stdout.write("help[1]: Run `linear-axi --help`\n");
    return 1;
  }
  return exitCode;
}

export async function run(args: string[], runtime: Runtime): Promise<string> {
  if (args.length === 0) {
    return renderToon(await homeCommand(runtime));
  }

  const [command, ...rest] = args;
  if (command === "--help" || command === "-h") return topHelp();
  const handler = COMMANDS[command];
  if (handler) return handler(rest, runtime);

  throw usage(`unknown command: ${command}`, [
    "Run `linear-axi`",
    'Run `linear-axi init --project "<project>"`',
    "Run `linear-axi issues list`",
    "Run `linear-axi projects list`",
    "Run `linear-axi teams list`",
  ]);
}

function trimFinalNewline(output: string): string {
  return output.endsWith("\n") ? output.slice(0, -1) : output;
}

function cliOptions(args: string[], context: MainContext) {
  return {
    argv: args.length === 1 && args[0] === "-h" ? ["--help"] : args,
    stdout: context.stdout,
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: topHelp(),
    home: withRuntimeCleanup(async (_args, runtime) => homeCommand(runtime)),
    commands: Object.fromEntries(
      Object.entries(COMMANDS)
        .filter((entry): entry is [string, Command] => entry[1] !== undefined)
        .map(([name, command]) => [
          name,
          withRuntimeCleanup(async (commandArgs, runtime) =>
            trimFinalNewline(await command(commandArgs, runtime)),
          ),
        ]),
    ),
    resolveContext: () => makeRuntime(context),
    formatError,
  };
}

function withRuntimeCleanup(handler: (args: string[], runtime: Runtime) => Promise<Renderable>) {
  return async (args: string[], runtime: Runtime) => {
    try {
      return await handler(args, runtime);
    } finally {
      await runtime.client.close?.();
    }
  };
}

export function formatError(error: unknown): { output: string; exitCode: number } {
  const rateLimit = rateLimitInfoFromError(error);
  if (error instanceof RawGraphqlInputError) {
    return { output: renderToon({ error: error.message, effect: error.effect }), exitCode: 1 };
  }
  if (error instanceof ManagedAuthError) {
    return {
      output: JSON.stringify({
        event: "error",
        error: error.message,
        ...(error.effect ? { effect: error.effect } : {}),
      }),
      exitCode: 1,
    };
  }
  if (error instanceof SdkAxiError) {
    return {
      output: renderToon({
        error: error.message,
        code: error.code,
        ...(rateLimit ? { rateLimit: JSON.stringify(rateLimit) } : {}),
        ...(error.suggestions.length > 0 ? { help: error.suggestions } : {}),
      }),
      exitCode: exitCodeForError(error),
    };
  }

  const axiError = normalizeError(error);
  return {
    output: renderToon({
      error: axiError.message,
      code: axiError.code,
      type: axiError.type,
      ...(error instanceof ResourceOperationFailure && error.effect
        ? { effect: error.effect }
        : {}),
      ...(rateLimit ? { rateLimit: JSON.stringify(rateLimit) } : {}),
      ...(axiError.help.length > 0 ? { help: axiError.help } : {}),
    }),
    exitCode: axiError.exitCode,
  };
}

export async function makeRuntime(context: MainContext): Promise<Runtime> {
  const env = await loadDotEnv(context.env, context.cwd);
  const url = await resolveMcpUrl(env);
  const connection = new NamedConnections({ env: { ...env, LINEAR_AXI_MCP_URL: url } });
  const preflightCache = context.client
    ? undefined
    : new LinearPreflightCache({
        directory: connection.path + ".preflight",
        scope: async () => {
          await connection.assertEpoch();
          const status = await connection.epoch();
          return status.connectionId && ["connected", "expired"].includes(status.state)
            ? { connectionId: status.connectionId, epoch: status.epoch, server: url }
            : undefined;
        },
      });
  const tokenProvider = new LinearAppTokenProvider({ env, connection });
  const fetchImpl: typeof fetch | undefined = preflightCache
    ? (input: Parameters<typeof fetch>[0], init?: RequestInit) => preflightCache.fetch(input, init)
    : undefined;
  const graphql = new LinearGraphqlClient({
    endpoint: env.LINEAR_AXI_GRAPHQL_URL,
    tokenProvider,
    fetchImpl,
    onRateLimit: preflightCache
      ? (headers) =>
          preflightCache.rateLimited(
            env.LINEAR_AXI_GRAPHQL_URL ?? "https://api.linear.app/graphql",
            headers,
          )
      : undefined,
  });
  const storage = new LinearStorageClient({
    endpoint: env.LINEAR_AXI_GRAPHQL_URL,
    tokenProvider,
    fetchImpl,
    onRateLimit: preflightCache
      ? (headers) =>
          preflightCache.rateLimited(
            env.LINEAR_AXI_GRAPHQL_URL ?? "https://api.linear.app/graphql",
            headers,
          )
      : undefined,
  });
  return {
    cwd: context.cwd,
    env,
    binPath: executablePath(),
    mcpUrl: url,
    stdout: context.stdout,
    stdin: context.stdin ?? process.stdin,
    preflightCache,
    connection,
    client:
      context.client ??
      new LinearMcpClient({
        url,
        token: env.LINEAR_AXI_MCP_TOKEN ?? env.LINEAR_MCP_TOKEN,
        authStorePath: env.LINEAR_AXI_AUTH_FILE,
        connection,
        preflightCache,
      }),
    searchClient: graphql,
    storageClient: storage,
  };
}

function executablePath(): string {
  const path = process.argv.at(1) ?? "linear-axi";
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
