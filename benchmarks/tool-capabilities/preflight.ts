import { cp, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import type * as PiSdk from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectorCatalog, connectorEnvironment, prepareConnector } from "./connectors.ts";
import { piRuntime } from "./inventory.ts";
import { prepareTrial, runProcess, sandboxArgs, snapshotSource } from "./sandbox.ts";

const syntheticAccess = "sk-ant-oat01-PREFLIGHT_ONLY_NOT_A_CREDENTIAL";
const redact = (value: string) => value.split(syntheticAccess).join("[synthetic access]");

/** Free preflight never accepts inference selection or a real authentication source. */
export function assertPreflightInvocation(args: readonly string[]): void {
  const forbidden = [
    "--run",
    "--auth-dir",
    "--claude-state",
    "--tui",
    "--model",
    "--case",
    "--mode",
    "--attempts",
    "--list",
    "--list-connectors",
    "--check",
    "--record-contracts",
  ];
  if (!args.includes("--preflight") || forbidden.some((flag) => args.includes(flag)))
    throw Error(
      "--preflight cannot be combined with inference, authentication inputs or other actions",
    );
  for (const required of ["--connector", "--connector-root"])
    if (
      args.filter((arg) => arg === required).length !== 1 ||
      !args[args.indexOf(required) + 1] ||
      args[args.indexOf(required) + 1]?.startsWith("--")
    )
      throw Error("--preflight requires one explicit --connector and --connector-root");
}

/** Add mandatory network namespace isolation before Bubblewrap's command separator. */
export function preflightSandboxArgs(args: readonly string[]): string[] {
  const separator = args.lastIndexOf("--");
  if (separator < 0 || args.includes("--share-net"))
    throw Error("Unsafe preflight sandbox arguments");
  return [...args.slice(0, separator), "--unshare-net", ...args.slice(separator)];
}

interface ChildCapture {
  kind: "connector-load-preflight";
  provider: string;
  processIdentity: { uid?: number; gid?: number };
  networkNamespace: string;
  phases: string[];
  errors: { path?: string; event?: string; error: string }[];
  models: { provider: string; id: string; name: string; api: string; input: unknown }[];
  tools: {
    name: string;
    exposure: string;
    namespace?: string;
    parameters: unknown;
    sourceInfo: unknown;
  }[];
  activeTools: string[];
  shutdownTools: string[];
  unexpectedAgentStarts: number;
}

/** Load and bind actual extensions with the installed public SDK, without submitting a prompt. */
async function capturePreflightChild(): Promise<void> {
  if (process.env.CAPABILITY_PREFLIGHT_CHILD !== "1")
    throw Error("Preflight child requires its isolated launcher");
  const sdkPath = process.env.CAPABILITY_PREFLIGHT_SDK;
  const provider = process.env.CAPABILITY_PREFLIGHT_PROVIDER;
  if (!sdkPath || !provider) throw Error("Missing preflight runtime identity");
  const sdk = (await import(pathToFileURL(sdkPath).href)) as typeof PiSdk;
  const settingsManager = sdk.SettingsManager.inMemory({
    defaultTools: [
      "read",
      "write",
      "bash",
      "search",
      "replace",
      "insert",
      "delete",
      "copy",
      "move",
      "diff",
      "undo",
      "codemode",
      "tool_search",
    ],
    codemode: { mode: "on" },
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0 },
  });
  const capture: ChildCapture = {
    kind: "connector-load-preflight",
    provider,
    processIdentity: { uid: process.getuid?.(), gid: process.getgid?.() },
    networkNamespace: await readlink("/proc/self/ns/net"),
    phases: [],
    errors: [],
    models: [],
    tools: [],
    activeTools: [],
    shutdownTools: [],
    unexpectedAgentStarts: 0,
  };
  let api: ExtensionAPI | undefined;
  let session: AgentSession | undefined;
  try {
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: "/state/agent/auth.json",
      modelsPath: null,
      modelsStorePath: "/state/models-cache.json",
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd: "/workspace/fixture",
      agentDir: "/state/agent",
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [
        "/source/src/pi-agent-ide.ts",
        "builtin:codemode",
        "builtin:tool-search",
        ...(JSON.parse(process.env.CAPABILITY_PREFLIGHT_EXTENSIONS ?? "[]") as string[]),
      ],
      extensionFactories: [
        {
          name: "codemode",
          builtin: true,
          replaceable: true,
          factory: sdk.createCodemodeExtension({ mode: "on" }),
        },
        {
          name: "tool-search",
          builtin: true,
          replaceable: true,
          factory: sdk.createToolSearchExtension(),
        },
        (pi) => {
          api = pi;
          pi.on("session_start", () => {
            capture.phases.push("session_start");
          });
          pi.on("session_shutdown", () => {
            capture.phases.push("session_shutdown");
          });
        },
      ],
    });
    await loader.reload();
    capture.phases.push("loaded_factories");
    capture.errors.push(
      ...loader.getExtensions().errors.map((error) => ({ path: error.path, error: error.error })),
    );
    ({ session } = await sdk.createAgentSession({
      cwd: "/workspace/fixture",
      agentDir: "/state/agent",
      resourceLoader: loader,
      settingsManager,
      modelRuntime,
      sessionManager: sdk.SessionManager.inMemory("/workspace/fixture"),
      excludeTools: ["edit", "grep", "find", "ls"],
    }));
    session.subscribe((event) => {
      if (event.type === "agent_start") {
        capture.unexpectedAgentStarts++;
        void session?.abort();
      }
    });
    await session.bindExtensions({
      mode: "json",
      onError: (error) => {
        capture.errors.push({ path: error.extensionPath, event: error.event, error: error.error });
      },
    });
    if (!api) throw Error("Preflight observer did not load");
    capture.models = modelRuntime.getModels(provider).map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      api: model.api,
      input: model.input,
    }));
    capture.tools = api.getAllTools().map((tool) => ({
      name: tool.name,
      exposure: tool.exposure,
      namespace: tool.namespace?.name,
      parameters: tool.parameters,
      sourceInfo: tool.sourceInfo,
    }));
    capture.activeTools = api.getActiveTools();
    if (!capture.models.length)
      capture.errors.push({ error: `Selected provider ${provider} declares no models` });
  } catch (error) {
    capture.errors.push({ error: String(error) });
  } finally {
    if (session) {
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        capture.shutdownTools = api?.getAllTools().map((tool) => tool.name) ?? [];
      } catch (error) {
        capture.errors.push({ event: "session_shutdown", error: String(error) });
      } finally {
        session.dispose();
        capture.phases.push("disposed");
      }
    }
    await writeFile("/state/preflight.json", redact(JSON.stringify(capture, null, 2)) + "\n");
  }
}

/** Retained preflight evidence is explicitly separate from paid compatibility attempts. */
export interface PreflightReport {
  kind: "connector-load-preflight";
  status: "loaded" | "unavailable" | "load_failed" | "timed_out" | "cancelled" | "infra_error";
  inference: false;
  networkIsolation: "required";
  /** Null means no child namespace observation was available. */
  networkIsolated: boolean | null;
  syntheticCredentialsOnly: true;
  connector: unknown;
  source?: { revision: string; digest: string };
  pi?: { version: string; sdk: string; cli: string };
  observed?: ChildCapture;
  reasons: string[];
  limitations: string[];
}

function limitations(id: string, auth: string): string[] {
  const notes = [
    "The preflight submits no prompt or provider inference call. Loading does not prove request transport, TUI or live authentication.",
    "Network isolation blocks lifecycle background traffic; lack of a loader error does not prove absence of attempted traffic.",
    "before_agent_start and request-time/deferred tool registration are not exercised.",
    auth === "claude"
      ? "Only a synthetic Claude token environment was supplied. No Claude credential file was materialized; file-based auth remains a separate prerequisite."
      : "Only the selected provider's synthetic Pi OAuth entry was supplied. No existing credential was re-keyed or refreshed.",
  ];
  if (auth === "separate") notes.push("A synthetic provider entry is not a dedicated login.");
  if (id === "agent-sdk")
    notes.push(
      "Source resolves Anthropic Pi auth despite model provider claude-bridge and asks for two hours token validity; this preflight does not adapt that auth source.",
    );
  if (id === "claude-auth")
    notes.push(
      "Source requires HOME/.claude/.credentials.json and a refresh-token string; current environment-only staging does not satisfy that file route.",
    );
  if (id === "cgaravitoq")
    notes.push(
      "Login materializes Pi OAuth and can refresh Claude credentials. No login/refresh is attempted; inspect declared models before selecting an approved profile.",
    );
  if (id === "adeildo")
    notes.push(
      "Pi cache warming is disabled and network is isolated. Extension cache/account background behavior remains unverified for live runs.",
    );
  if (id === "request-compat")
    notes.push(
      "Connector embeds Pi AI 0.87.1; loading does not establish cross-version request compatibility. All install scripts remain disabled.",
    );
  return notes;
}

/** Freeze one verified connector, then load its lifecycle in a fresh no-network namespace. */
export async function runConnectorPreflight(
  repository: string,
  options: {
    connector: string;
    connectorRoot: string;
    executable?: string;
    pi?: string;
    timeoutMs?: number;
    results?: string;
    signal?: AbortSignal;
  },
): Promise<{ directory: string; report: PreflightReport }> {
  const definition = connectorCatalog.find((item) => item.id === options.connector);
  if (!definition) throw Error(`Unknown connector: ${options.connector}`);
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw Error("Invalid preflight timeout");
  const directory = path.resolve(
    options.results ??
      path.join(
        repository,
        ".tmp/capability-preflights",
        `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
      ),
  );
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  const report: PreflightReport = {
    kind: "connector-load-preflight",
    status: "unavailable",
    inference: false,
    networkIsolation: "required",
    networkIsolated: null,
    syntheticCredentialsOnly: true,
    connector: { definition },
    reasons: [],
    limitations: limitations(definition.id, definition.auth),
  };
  let parent: string | undefined;
  try {
    const verified = await prepareConnector(
      definition.id,
      options.connectorRoot,
      `${definition.provider}/preflight-no-inference`,
      options.executable,
    );
    report.connector = { definition, artifact: verified.metadata };
    const runtime = await piRuntime(options.pi ?? "pi");
    if (
      !["/usr/", "/opt/", path.join(os.homedir(), ".local/lib") + path.sep].some((root) =>
        runtime.sdk.startsWith(root),
      )
    )
      throw Error("Preflight requires an installed Pi inside existing read-only toolchain mounts");
    report.pi = { version: runtime.version, sdk: runtime.sdk, cli: runtime.cli };
    report.status = "infra_error";
    await mkdir(path.join(repository, ".tmp"), { recursive: true });
    parent = await mkdtemp(path.join(repository, ".tmp/capability-preflight-"));
    const frozenRoot = path.join(parent, "connector");
    await cp(verified.root, frozenRoot, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (file) => path.basename(file) !== ".git",
    });
    const executable = verified.executable ? path.join(parent, "claude") : undefined;
    if (verified.executable && executable) await cp(verified.executable, executable);
    const frozen = await prepareConnector(
      definition.id,
      frozenRoot,
      `${definition.provider}/preflight-no-inference`,
      executable,
    );
    if (
      frozen.metadata.digest !== verified.metadata.digest ||
      frozen.metadata.executableDigest !== verified.metadata.executableDigest
    )
      throw Error("Connector artifact changed while freezing preflight");
    const snapshot = await snapshotSource(repository, parent);
    report.source = { revision: snapshot.revision, digest: snapshot.digest };
    const trial = await prepareTrial(parent, snapshot.source, {
      id: "connector-preflight",
      capabilities: [],
      modes: [],
      steps: [],
      files: {},
    });
    const synthetic =
      definition.auth === "claude"
        ? {}
        : {
            [definition.authProvider ?? definition.provider]: {
              type: "oauth",
              access: syntheticAccess,
              refresh: "",
              expires: Date.now() + 24 * 60 * 60 * 1000,
            },
          };
    await writeFile(path.join(trial.state, "agent/auth.json"), JSON.stringify(synthetic), {
      mode: 0o600,
    });
    const args = preflightSandboxArgs(await sandboxArgs(snapshot.source, trial.root, frozen));
    const execution = await runProcess(
      "bwrap",
      [...args, process.execPath, "/source/benchmarks/tool-capabilities/preflight.ts", "--child"],
      {
        env: {
          PATH: "/tools:/usr/local/bin:/usr/bin:/bin",
          HOME: "/state/home",
          PI_CODING_AGENT_DIR: "/state/agent",
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          ...connectorEnvironment(frozen),
          ...(definition.auth === "claude" && { CLAUDE_CODE_OAUTH_TOKEN: syntheticAccess }),
          CAPABILITY_PREFLIGHT_CHILD: "1",
          CAPABILITY_PREFLIGHT_SDK: runtime.sdk,
          CAPABILITY_PREFLIGHT_PROVIDER: definition.provider,
          CAPABILITY_PREFLIGHT_EXTENSIONS: JSON.stringify(frozen.extensions),
        },
        timeoutMs,
        signal: options.signal,
      },
    );
    await writeFile(path.join(directory, "stdout.log"), redact(execution.stdout));
    await writeFile(path.join(directory, "stderr.log"), redact(execution.stderr));
    await writeFile(
      path.join(directory, "execution.json"),
      JSON.stringify(
        {
          code: execution.code,
          signal: execution.signal,
          timedOut: execution.timedOut,
          hostNetworkNamespace: await readlink("/proc/self/ns/net"),
        },
        null,
        2,
      ),
    );
    try {
      report.observed = JSON.parse(
        await readFile(path.join(trial.state, "preflight.json"), "utf8"),
      ) as ChildCapture;
    } catch {
      report.reasons.push("No completed public-SDK load capture was retained");
    }
    report.networkIsolated = report.observed
      ? report.observed.networkNamespace !== (await readlink("/proc/self/ns/net"))
      : null;
    if (options.signal?.aborted) report.status = "cancelled";
    else if (execution.timedOut) report.status = "timed_out";
    else if (execution.code !== 0) {
      report.status = "infra_error";
      report.reasons.push(redact(execution.stderr || `Preflight child exited ${execution.code}`));
    } else if (
      !report.observed ||
      report.observed.errors.length ||
      report.observed.unexpectedAgentStarts > 0
    ) {
      report.status = "load_failed";
      report.reasons.push(...(report.observed?.errors.map((error) => error.error) ?? []));
      if (report.observed?.unexpectedAgentStarts)
        report.reasons.push("An extension attempted to start an agent run during load preflight");
    } else if (report.networkIsolated !== true) {
      report.status = "infra_error";
      report.reasons.push("Preflight did not enter a separate network namespace");
    } else report.status = "loaded";
  } catch (error) {
    report.reasons.push(redact(String(error)));
  } finally {
    try {
      await writeFile(
        path.join(directory, "preflight.json"),
        redact(JSON.stringify(report, null, 2)) + "\n",
      );
    } finally {
      if (parent) await rm(parent, { recursive: true, force: true });
    }
  }
  return { directory, report };
}

if (process.argv[2] === "--child") await capturePreflightChild();
