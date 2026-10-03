import spawn from "cross-spawn";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type Message,
  type MessageConnection,
} from "vscode-jsonrpc/node";

import { DapClient } from "./dap-client.js";
import type { DebugSessionOptions } from "./session-manager.js";

/** Java executable shared by the owned language server and target JVM. */
export function javaExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.PI_JAVA_PATH ??
    (env.JAVA_HOME === undefined
      ? "java"
      : path.join(env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"))
  );
}

/** Resolve the actual Java debugger files, with no dependency on the Kotlin adapter. */
export async function javaDebuggerFiles(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<{ launcher: string; configuration: string; plugin: string }> {
  const home = env.PI_JDTLS_HOME ?? "/opt/pi-debug-adapters/jdtls";
  const plugin =
    env.PI_JAVA_DEBUG_PLUGIN_PATH ??
    "/opt/pi-debug-adapters/java-debug/com.microsoft.java.debug.plugin-0.53.2.jar";
  const configuration = path.join(home, platform === "win32" ? "config_win" : "config_linux");
  try {
    const launchers = (await readdir(path.join(home, "plugins"))).filter((name) =>
      /^org\.eclipse\.equinox\.launcher_[^/]+\.jar$/u.test(name),
    );
    if (launchers.length !== 1) throw new Error("Expected one Equinox launcher jar");
    const launcher = path.join(home, "plugins", launchers[0] as string);
    if (
      !(await stat(launcher)).isFile() ||
      !(await stat(plugin)).isFile() ||
      !(await stat(configuration)).isDirectory()
    ) {
      throw new Error("Expected JDT LS configuration and Java debug plugin files");
    }
    return { launcher, configuration, plugin };
  } catch (error) {
    throw new Error(
      `Java debugger requires JDT LS (PI_JDTLS_HOME) and java-debug plugin (PI_JAVA_DEBUG_PLUGIN_PATH): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Own one JDT LS/java-debug server and a suspended target JVM for a Java session. */
export class JavaDebugRuntime {
  #server?: ChildProcessWithoutNullStreams;
  #target?: ChildProcessWithoutNullStreams;
  #connection?: MessageConnection;
  #client?: DapClient;
  #directory?: string;
  #closing?: Promise<void>;

  /** Owned JVM ids, useful for checking cleanup without searching by process name. */
  get processIds(): readonly number[] {
    return [this.#server?.pid, this.#target?.pid].filter((pid): pid is number => pid !== undefined);
  }

  /** Start the documented JDT LS bridge and target; neither attach nor resume the target yet. */
  async start(
    options: DebugSessionOptions,
    signal: AbortSignal,
  ): Promise<{
    client: DapClient;
    attach: Readonly<Record<string, unknown>>;
  }> {
    signal.throwIfAborted();
    if (options.mainClass === undefined) throw new Error("Java debug sessions require mainClass");
    const classPaths = await javaClassPaths(options);
    const client = await this.connect(options.cwd, signal);
    // Port 0 is allocated by the target itself. suspend=y protects the first breakpoint
    // until java-debug attaches, installs listeners, and receives configurationDone.
    signal.throwIfAborted();
    this.#target = this.#spawn(
      [
        "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0",
        "-cp",
        classPaths.join(path.delimiter),
        options.mainClass,
        ...options.args,
      ],
      options.cwd,
      process.env,
    );
    const targetPort = await targetReady(this.#target, signal);
    let sourceRoot = path.dirname(options.sourceFile);
    for (const _segment of options.mainClass.split(".").slice(1))
      sourceRoot = path.dirname(sourceRoot);
    return {
      client,
      attach: {
        hostName: "127.0.0.1",
        port: targetPort,
        timeout: 10_000,
        sourcePaths: [sourceRoot],
      },
    };
  }

  /** Open the documented Java DAP bridge without launching a target, also used by Doctor. */
  async connect(
    cwd: string,
    signal: AbortSignal,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<DapClient> {
    signal.throwIfAborted();
    const files = await javaDebuggerFiles(env);
    this.#directory = await mkdtemp(path.join(tmpdir(), "pi-java-debug-"));
    const configuration = path.join(this.#directory, "configuration");
    await cp(files.configuration, configuration, { recursive: true });
    const serverEnv = { ...env };
    delete serverEnv.CLIENT_PORT;
    delete serverEnv.CLIENT_HOST;
    signal.throwIfAborted();
    this.#server = this.#spawn(
      [
        "-Declipse.application=org.eclipse.jdt.ls.core.id1",
        "-Dosgi.bundles.defaultStartLevel=4",
        "-Declipse.product=org.eclipse.jdt.ls.core.product",
        "-Xmx512m",
        "--add-modules=ALL-SYSTEM",
        "--add-opens",
        "java.base/java.util=ALL-UNNAMED",
        "--add-opens",
        "java.base/java.lang=ALL-UNNAMED",
        "-jar",
        files.launcher,
        "-configuration",
        configuration,
        "-data",
        path.join(this.#directory, "workspace"),
      ],
      cwd,
      serverEnv,
    );
    const server = this.#server;
    // Do not enqueue JSON-RPC writes until spawn succeeds; failed spawns destroy stdin.
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.once("spawn", resolve);
        server.once("error", reject);
      }),
      signal,
    );
    const crashed = new AbortController();
    const writer = new (class extends StreamMessageWriter {
      override async write(message: Message): Promise<void> {
        try {
          await super.write(message);
        } catch (error) {
          // jsonrpc's async request executor rethrows writer failures as unhandled promises.
          // Route the transport failure to the bounded startup instead.
          crashed.abort(error);
        }
      }
    })(server.stdin);
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), writer);
    this.#connection = connection;
    let stderr = "";
    server.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4_000);
    });
    server.once("error", (error) => crashed.abort(error));
    server.once("exit", (code) =>
      crashed.abort(new Error(`Java debugger language server exited (${String(code)}): ${stderr}`)),
    );
    const startupSignal = AbortSignal.any([signal, crashed.signal]);
    connection.onRequest("workspace/configuration", (parameters: { items: unknown[] }) =>
      parameters.items.map(() => null),
    );
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.listen();
    await bounded(
      connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(cwd).href,
        capabilities: {},
        initializationOptions: {
          bundles: [files.plugin],
          settings: { java: { import: { gradle: { enabled: false }, maven: { enabled: false } } } },
        },
      }),
      startupSignal,
    );
    await connection.sendNotification("initialized", {});
    const port = await bounded(
      connection.sendRequest<unknown>("workspace/executeCommand", {
        command: "vscode.java.startDebugSession",
        arguments: [],
      }),
      startupSignal,
    );
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("JDT LS did not return a Java DAP port; check PI_JAVA_DEBUG_PLUGIN_PATH");
    }
    this.#client = await connectDap(port, startupSignal);
    return this.#client;
  }

  /** Stop only the two owned JVMs, close transports, and remove the private server workspace. */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#client?.close();
    this.#connection?.dispose();
    await Promise.all([stopProcess(this.#target), stopProcess(this.#server)]);
    if (this.#directory !== undefined)
      await rm(this.#directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  #spawn(
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): ChildProcessWithoutNullStreams {
    const child = spawn(javaExecutable(env), [...args], {
      cwd,
      env,
      stdio: "pipe",
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    // Closing a failed server can race its pending JSON-RPC writes.
    child.stdin.on("error", () => {});
    return child;
  }
}

function connectDap(port: number, signal: AbortSignal): Promise<DapClient> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    const abort = (): void => {
      socket.destroy();
      reject(signal.reason);
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
    socket.once("connect", () => {
      cleanup();
      resolve(DapClient.fromSocket(socket));
    });
  });
}
async function javaClassPaths(options: DebugSessionOptions): Promise<string[]> {
  const mainFile = `${(options.mainClass as string).replaceAll(".", path.sep)}.class`;
  const candidates = ["build/classes/java/main", "target/classes", "out/production", "bin", "."];
  const paths: string[] = [];
  for (const candidate of candidates) {
    const directory = path.resolve(options.cwd, candidate);
    try {
      if ((await stat(path.join(directory, mainFile))).isFile()) paths.push(directory);
    } catch {
      /* This build output is not present. */
    }
  }
  if (paths.length === 0)
    throw new Error(
      `Java main class ${options.mainClass} is not compiled. Compile with javac -g into build/classes/java/main, target/classes, out/production, bin, or the project directory.`,
    );
  return paths;
}

async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function targetReady(child: ChildProcessWithoutNullStreams, signal: AbortSignal): Promise<number> {
  return bounded(
    new Promise<number>((resolve, reject) => {
      let output = "";
      const consume = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-4_000);
        const match = /Listening for transport dt_socket at address: (\d+)/u.exec(output);
        if (match !== null) resolve(Number(match[1]));
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Java target exited before JDWP was ready (${String(code)}): ${output}`)),
      );
    }),
    signal,
  );
}

async function stopProcess(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (
    child === undefined ||
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(force);
      clearTimeout(deadline);
      child.removeListener("exit", exited);
      child.removeListener("error", failed);
    };
    const exited = (): void => {
      cleanup();
      resolve();
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const force = setTimeout(() => {
      child.kill("SIGKILL");
    }, 500);
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Could not stop owned Java process ${String(child.pid)} within 2 seconds`));
    }, 2_000);
    child.once("exit", exited);
    child.once("error", failed);
    child.kill();
  });
}
