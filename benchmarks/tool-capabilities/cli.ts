import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { findRepositoryRoot } from "#scripts/repository-root.ts";
import { capabilityCases } from "./cases.ts";
import { capabilityMatrix } from "./matrix.ts";
import {
  connectorCatalog,
  connectorEnvironment,
  ConnectorUnavailable,
  prepareConnector,
  stageConnectorState,
  type PreparedConnector,
} from "./connectors.ts";
import {
  checkCoverage,
  parseEvents,
  validateRoute,
  servedIdentity,
  type CapabilityCase,
  type RunEvent,
} from "./validation.ts";
import { piRuntime, toolInventory, type Inventory } from "./inventory.ts";
import {
  assertTuiInvocation,
  assertTuiHistoryInvocation,
  TUI_HISTORY_SESSION,
  reopenTuiHistory,
} from "./tui.ts";
import { accountStopReason } from "./run-policy.ts";
import { assertPreflightInvocation, runConnectorPreflight } from "./preflight.ts";
import {
  AuthenticationUnavailable,
  assertDedicatedAuthInvocation,
  stagePiAuthentication,
  stageDedicatedPiAuthentication,
  type StagedAuthentication,
} from "./auth.ts";
import {
  cleanupTrial,
  prepareTrial,
  runProcess,
  sandboxArgs,
  snapshotSource,
  validateFiles,
  fixtureFiles,
} from "./sandbox.ts";

interface Profile {
  id: string;
  model: string;
  thinking: string;
  /** Exact backend response ID when the profile deliberately selects a provider alias. */
  servedModel?: string;
}
interface ConnectorRun {
  id: string;
  prepared?: PreparedConnector;
  unavailable?: string;
  piAuthDir?: string;
  claudeState?: string;
}
interface Attempt {
  surface: "json" | "tui";
  case: string;
  mode: string;
  model: string;
  status: string;
  reasons: string[];
  evidence: string;
  connector?: string;
  requestedModel?: string;
  servedModels?: string[];
}
function connectorEvidence(run: ConnectorRun | undefined): unknown {
  return run
    ? {
        definition: connectorCatalog.find((entry) => entry.id === run.id),
        artifact: run.prepared?.metadata,
        unavailable: run.unavailable,
        piAutomaticRetries: 0,
      }
    : undefined;
}
const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = findRepositoryRoot(import.meta.url);
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const flags = new Set([
  "--help",
  "--list",
  "--list-connectors",
  "--check",
  "--record-contracts",
  "--preflight",
  "--run",
  "--tui",
  "--tui-history",
  "--dedicated-auth",
]);
const options = new Set([
  "--model",
  "--case",
  "--mode",
  "--attempts",
  "--timeout",
  "--results",
  "--pi",
  "--auth-dir",
  "--connector",
  "--connector-root",
  "--claude-state",
  "--claude-executable",
]);
for (let index = 0; index < args.length; index++) {
  const arg = args[index] ?? "";
  if (flags.has(arg)) continue;
  if (!options.has(arg) || !args[index + 1] || args[index + 1]?.startsWith("--"))
    throw Error(`Unknown or incomplete option: ${arg}`);
  index++;
}
const value = (flag: string, fallback?: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const json = async (file: string, data: unknown) => {
  await writeFile(file, JSON.stringify(data, null, 2) + "\n");
};

async function coverage(command: string): Promise<Inventory> {
  const live = await toolInventory(repository, command);
  const saved = JSON.parse(
    await readFile(path.join(directory, "contracts.json"), "utf8"),
  ) as Inventory;
  const problems = checkCoverage(
    capabilityMatrix,
    capabilityCases,
    live.tools.map((tool) => tool.name),
  );
  if (JSON.stringify(live.tools) !== JSON.stringify(saved.tools))
    problems.push(
      "Live tool schemas changed. Review matrix/cases and explicitly record the reviewed contracts.",
    );
  if (problems.length) throw Error(problems.join("\n"));
  console.log(
    `Coverage: ${live.tools.length} live IDE tools, ${capabilityMatrix.length} capabilities, ${capabilityCases.length} cases. No model calls.`,
  );
  return live;
}

function prompt(task: CapabilityCase, mode: string): string {
  return `This is a small tool capability check in a disposable fixture.\n${task.prompt}\nRequired execution route (in order; extra inspection is allowed): ${task.steps.map((step) => step.tool).join(" → ")}.\n${mode === "codemode" ? "Perform every requested IDE operation inside native Codemode. Keep tool results unchanged when passing them between calls." : "Use direct tool calls for the requested IDE operations, not Codemode."}\nUse the requested route, not shell/file-editing substitutes. Extra inspection is allowed. Do not modify unrelated files. Finish with a short factual answer.\n`;
}

function finalText(events: RunEvent[]): string {
  return (
    events
      .findLast((event) => event.type === "message_end" && event.message?.role === "assistant")
      ?.message?.content?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n") ?? ""
  );
}

async function report(
  root: string,
  profiles: Profile[],
  attempts: Attempt[],
  manifest: unknown,
): Promise<void> {
  await json(path.join(root, "manifest.json"), manifest);
  await json(path.join(root, "attempts.json"), attempts);
  const columns = profiles.flatMap((profile) =>
    ["direct", "codemode"].map((mode) => ({ profile: profile.id, mode })),
  );
  const rows = capabilityMatrix.map((capability) => {
    const cells = columns.map((column) => {
      const required = capability.cases.filter((id) =>
        capabilityCases.find((task) => task.id === id)?.modes.includes(column.mode),
      );
      if (!required.length) return "not applicable";
      return required
        .map((id) => {
          const observed = attempts.filter(
            (attempt) =>
              attempt.case === id &&
              attempt.mode === column.mode &&
              attempt.model === column.profile,
          );
          if (!observed.length) return `${id}: not run`;
          const pass = observed.some((attempt) => attempt.status === "pass");
          return (
            `${id}: ${pass ? "observed pass" : "unverified"} (${observed.filter((attempt) => attempt.status === "pass").length}/${observed.length}) ` +
            observed
              .map((attempt) => `[${attempt.status}](${attempt.evidence}/result.json)`)
              .join(" ")
          );
        })
        .join("<br>");
    });
    return `| ${capability.id} | ${cells.join(" | ")} |`;
  });
  await writeFile(
    path.join(root, "matrix.md"),
    `# Tool capability evidence\n\nAn observed pass establishes one executable route, not model quality or reliability. All attempts remain visible. Not run and unavailable are not passes.\n\n| Capability | ${columns.map((column) => `${column.profile} / ${column.mode}`).join(" | ")} |\n|---|${columns.map(() => "---|").join("")}\n${rows.join("\n")}\n`,
  );
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function attempt(
  source: string,
  parent: string,
  root: string,
  task: CapabilityCase,
  profile: Profile,
  mode: string,
  number: number,
  command: string,
  authDir: string,
  timeoutMs: number,
  signal: AbortSignal,
  connectorRun?: ConnectorRun,
  terminal = false,
  dedicatedAuth = false,
  inspectHistory = false,
): Promise<Attempt> {
  const evidence = `${connectorRun ? connectorRun.id + "--" : ""}${profile.id}--${task.id}--${mode}--${number}`;
  const artifacts = path.join(root, evidence);
  await mkdir(artifacts);
  const result: Attempt = {
    surface: terminal ? "tui" : "json",
    case: task.id,
    mode,
    model: profile.id,
    connector: connectorRun?.id,
    requestedModel: profile.model,
    status: "infra_error",
    reasons: [],
    evidence,
  };
  let prepared: Awaited<ReturnType<typeof prepareTrial>> | undefined;
  let authentication: StagedAuthentication | undefined;
  try {
    if (connectorRun?.unavailable) {
      result.status = "unavailable";
      result.reasons.push(connectorRun.unavailable);
      return result;
    }
    const connector = connectorRun?.prepared;
    prepared = await prepareTrial(parent, source, task);
    const bwrap = await sandboxArgs(source, prepared.root, connector);
    const modelProvider = profile.model.slice(0, profile.model.indexOf("/"));
    const authProvider = connector?.definition.authProvider ?? modelProvider;
    authentication = dedicatedAuth
      ? await stageDedicatedPiAuthentication(prepared.state, authProvider, authDir)
      : connector
        ? await stageConnectorState(
            connector,
            prepared.state,
            {
              piAuthDir: connectorRun.piAuthDir,
              claudeState: connectorRun.claudeState,
            },
            timeoutMs,
          )
        : await stagePiAuthentication(
            prepared.state,
            profile.model.slice(0, profile.model.indexOf("/")),
            authDir,
            timeoutMs,
          );
    if (authProvider !== modelProvider) {
      authentication.policy.modelProvider = modelProvider;
      await json(path.join(prepared.state, "auth-policy.json"), authentication.policy);
    }
    if (authentication.mount)
      bwrap.splice(-1, 0, "--bind", authentication.mount.source, authentication.mount.target);
    await json(path.join(artifacts, "authentication.json"), authentication.policy);
    const env = {
      PATH: [
        "/tools",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        path.join(os.homedir(), ".local/bin"),
      ].join(path.delimiter),
      PYTHONUSERBASE: path.join(os.homedir(), ".local"),
      HOME: "/state/home",
      PI_CODING_AGENT_DIR: "/state/agent",
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      ...(connector ? connectorEnvironment(connector) : {}),
      ...authentication.environment,
      CAPABILITY_AUTH_POLICY: "/state/auth-policy.json",
      CAPABILITY_TUI: terminal ? "1" : "0",
    };
    if (task.prerequisite) {
      const prerequisite = await runProcess(
        "bwrap",
        [...bwrap, "/bin/bash", "-lc", task.prerequisite],
        { env, timeoutMs: 15000, signal },
      );
      if (prerequisite.code !== 0) {
        result.status = "unavailable";
        result.reasons.push(`Missing prerequisite: ${task.prerequisite}`, prerequisite.stderr);
        return result;
      }
    }
    if (connector?.definition.cli)
      await json(path.join(prepared.state, "agent/claude-bridge.json"), {
        askClaude: { enabled: false },
        provider: { strictMcpConfig: true, pathToClaudeCodeExecutable: "/tools/claude" },
      });
    await json(path.join(prepared.state, "agent/settings.json"), {
      codemode: { mode: "on" },
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
      retry: { enabled: false, maxRetries: 0 },
    });
    const taskPrompt = prompt(task, mode);
    await writeFile(path.join(artifacts, "prompt.txt"), taskPrompt);
    const cli = await piRuntime(command);
    const piArgs = [
      "--approve",
      "--offline",
      ...(inspectHistory ? ["--session", TUI_HISTORY_SESSION] : ["--no-session"]),
      ...(terminal ? [] : ["--mode", "json"]),
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "-e",
      task.setup === "standalone-resource"
        ? "/source/tests/integration/fixtures/standalone-resource-provider.ts"
        : "/source/src/pi-agent-ide.ts",
      "-e",
      "builtin:codemode",
      "-e",
      "builtin:tool-search",
      "--model",
      profile.model,
      "--thinking",
      profile.thinking,
      "--exclude-tools",
      `edit,grep,find,ls${mode === "direct" ? ",codemode" : ""}`,
      ...(task.setup === "standalone-resource"
        ? []
        : ["--pi-agent-ide-no-post-processing", "true"]),
    ];
    for (const extension of connector?.extensions ?? []) piArgs.push("-e", extension);
    if (connector) piArgs.push("--provider", connector.definition.provider);
    if (task.setup === "semantic-write")
      piArgs.push("-e", "/source/benchmarks/tool-capabilities/semantic-write-fixture.ts");
    if (task.setup === "write-effects")
      piArgs.push("-e", "/source/tests/integration/support/write-saved-mismatch-resource.ts");
    if (task.setup === "write-hook")
      piArgs.push("-e", "/source/tests/integration/support/user-hooks-extension.ts");
    if (task.setup === "move-rollback")
      piArgs.push("-e", "/source/benchmarks/tool-capabilities/move-rollback-fixture.ts");
    if (task.setup === "move-effects")
      piArgs.push(
        "-e",
        "/source/src/extensions/pi-agent-text-editor/test/fixtures/move-effects-probe.ts",
      );
    piArgs.push("-e", "/source/benchmarks/tool-capabilities/observer.ts");
    piArgs.push("-e", "/source/benchmarks/tool-capabilities/auth-guard.ts");
    let launch = "";
    if (task.setup === "web")
      launch +=
        "node -e " +
        shellQuote(
          'require("http").createServer((req,res)=>{res.setHeader("Content-Type","text/html");res.end("<title>WEB-MARKER</title><main>WEB-MARKER</main>")}).listen(8765,"127.0.0.1")',
        ) +
        " &\nsleep 0.5\n";
    launch += ["node", cli.cli, ...piArgs, "--", taskPrompt].map(shellQuote).join(" ");
    const execution = await runProcess("bwrap", [...bwrap, "/bin/bash", "-c", launch], {
      env,
      timeoutMs,
      terminal,
      signal,
    });
    await json(path.join(artifacts, "execution.json"), {
      code: execution.code,
      signal: execution.signal,
      timedOut: execution.timedOut,
      terminalInherited: terminal,
    });
    let history: Awaited<ReturnType<typeof reopenTuiHistory>> | undefined;
    let historyFailure: string | undefined;
    if (inspectHistory && execution.code === 0 && !execution.timedOut && !signal.aborted) {
      console.log(
        "LPT769_HISTORY_REOPENING — no prompt; network disabled; /quit after screenshots",
      );
      try {
        history = await reopenTuiHistory({
          sandbox: bwrap,
          cli: cli.cli,
          piArgs,
          state: prepared.state,
          env,
          timeoutMs,
          signal,
        });
      } catch (error) {
        historyFailure = String(error);
      }
    }
    // Include every initial and rotated token in redaction before retaining any child output.
    await authentication.refreshSecrets?.();
    if (history) {
      await json(path.join(artifacts, "history-execution.json"), {
        code: history.execution.code,
        signal: history.execution.signal,
        timedOut: history.execution.timedOut,
        networkDisabled: true,
        reasons: history.reasons,
      });
      await writeFile(
        path.join(artifacts, "history-events.jsonl"),
        authentication.redact(history.events),
      );
      await writeFile(
        path.join(artifacts, "history-session.jsonl"),
        authentication.redact(history.session),
      );
    }
    let eventStream = execution.stdout;
    if (terminal) {
      try {
        eventStream = await readFile(path.join(prepared.state, "events.jsonl"), "utf8");
      } catch {
        result.reasons.push("No public TUI event mirror was retained");
      }
    }
    let suppressedSecret =
      authentication.containsSecret(eventStream) ||
      authentication.containsSecret(execution.stderr) ||
      Boolean(
        history &&
        (authentication.containsSecret(history.events) ||
          authentication.containsSecret(history.session)),
      );
    const stdout = authentication.redact(eventStream);
    const stderr = authentication.redact(execution.stderr);
    await writeFile(path.join(artifacts, "events.jsonl"), stdout);
    await writeFile(path.join(artifacts, "stderr.log"), stderr);
    const encode = (files: Record<string, Buffer>) =>
      Object.fromEntries(
        Object.entries(files).map(([file, bytes]) => {
          const text = bytes.toString("utf8");
          const safeFile = authentication?.redact(file) ?? file;
          if (authentication?.containsSecret(file)) suppressedSecret = true;
          if (authentication?.containsSecret(text)) {
            suppressedSecret = true;
            return [safeFile, Buffer.from(authentication.redact(text)).toString("base64")];
          }
          return [safeFile, bytes.toString("base64")];
        }),
      );
    await json(path.join(artifacts, "files.json"), {
      initial: encode(prepared.initial),
      final: encode(await fixtureFiles(prepared.cwd)),
    });
    try {
      const runtimeText = await readFile(path.join(prepared.state, "runtime.json"), "utf8");
      if (authentication.containsSecret(runtimeText)) suppressedSecret = true;
      await writeFile(path.join(artifacts, "runtime.json"), authentication.redact(runtimeText));
    } catch {
      /* A startup failure has no runtime capture. */
    }
    if (suppressedSecret) {
      result.reasons.push("Credential material was suppressed from execution evidence");
      return result;
    }
    if (signal.aborted) {
      result.status = "cancelled";
      return result;
    }
    if (execution.timedOut) {
      result.status = "timed_out";
      return result;
    }
    if (execution.code !== 0) {
      result.reasons.push(
        stderr ||
          (execution.signal
            ? `Pi terminated by ${execution.signal}`
            : `Pi exited ${execution.code}`),
      );
      return result;
    }
    if (historyFailure) {
      result.reasons.push(authentication.redact(historyFailure));
      await json(path.join(artifacts, "history-execution.json"), {
        error: authentication.redact(historyFailure),
        networkDisabled: true,
      });
      return result;
    }
    if (history?.reasons.length) {
      result.status = history.execution.timedOut ? "timed_out" : "infra_error";
      result.reasons.push(...history.reasons);
      return result;
    }
    const events = parseEvents(stdout);
    if (terminal && events.filter((event) => event.type === "agent_start").length !== 1) {
      result.reasons.push("TUI session must contain exactly one capability prompt");
      return result;
    }
    const identity = servedIdentity(events, profile.model, profile.servedModel);
    result.servedModels = identity.identities;
    await json(path.join(artifacts, "identity.json"), {
      requested: { model: profile.model, thinking: profile.thinking },
      servedModels: identity.identities,
      responseModels: identity.responseModels,
      responseModelObserved: Boolean(identity.responseModels?.length),
      expectedResponseModel:
        profile.servedModel ?? profile.model.slice(profile.model.indexOf("/") + 1),
      reasons: identity.reasons,
    });
    const failed = events.find(
      (event) =>
        event.type === "message_end" &&
        event.message?.role === "assistant" &&
        ["error", "aborted"].includes(event.message.stopReason ?? ""),
    );
    if (failed) {
      result.status = "model_error";
      result.reasons.push(
        failed.message?.errorMessage ?? failed.message?.stopReason ?? "Model failed",
      );
      return result;
    }
    if (!events.some((event) => event.type === "agent_settled")) {
      result.reasons.push("No final agent_settled event");
      return result;
    }
    const runtime = JSON.parse(
      await readFile(path.join(prepared.state, "runtime.json"), "utf8"),
    ) as { model: string; thinking: string; aliases?: Record<string, string> };
    if (runtime.model !== profile.model || runtime.thinking !== profile.thinking) {
      result.reasons.push("Selected runtime model/thinking differs from the requested profile");
      return result;
    }
    if (identity.reasons.length) {
      result.reasons.push(...identity.reasons);
      return result;
    }
    const route = validateRoute(
      task,
      events,
      mode,
      connector?.definition.aliases ? runtime.aliases : undefined,
    );
    const outcomes = await validateFiles(prepared.cwd, prepared.initial, task.expected);
    for (const file of Object.keys(await fixtureFiles(path.dirname(prepared.cwd))))
      if (!file.startsWith("fixture" + path.sep))
        outcomes.push(`Unexpected file outside the fixture: ${file}`);
    if (task.answer && !finalText(events).includes(task.answer))
      outcomes.push("Final answer does not contain the requested observed value");
    if (
      task.git &&
      execFileSync("git", ["status", "--porcelain"], { cwd: prepared.cwd, encoding: "utf8" }).trim()
    )
      outcomes.push("Git source/index are not clean");
    result.reasons.push(...route.reasons, ...outcomes);
    result.status = !route.passed ? "route_failed" : outcomes.length ? "outcome_failed" : "pass";
    await json(
      path.join(artifacts, "tool-errors.json"),
      events.filter((event) => event.type === "tool_execution_end" && event.isError),
    );
    return result;
  } catch (error) {
    if (error instanceof ConnectorUnavailable || error instanceof AuthenticationUnavailable)
      result.status = "unavailable";
    result.reasons.push(String(error));
    return result;
  } finally {
    try {
      await authentication?.refreshSecrets?.();
    } catch {
      result.status = "infra_error";
      result.reasons = ["Private credential audit failed"];
    }
    try {
      if (prepared) await cleanupTrial(parent, prepared.root);
    } finally {
      await authentication?.release?.();
    }
    result.reasons = result.reasons.map((reason) => authentication?.redact(reason) ?? reason);
    await json(path.join(artifacts, "result.json"), result);
  }
}

async function main(): Promise<void> {
  if (args.includes("--help") || !args.length) {
    console.log(
      "Tool capability matrix (Linux/WSL, Bubblewrap)\n\nFree: --list | --list-connectors | --check | --record-contracts (after reviewing changed tools) | --preflight --connector ID --connector-root PRESTAGED_PREFIX [--claude-executable FILE]\nPaid: --run --model PROFILE_ID[,PROFILE_ID] [--case ID[,ID]] [--mode direct|codemode] [--attempts N] [--timeout SECONDS] [--tui [--tui-history]] [--results NEW_DIR] [--pi COMMAND] [--auth-dir DIR] [--dedicated-auth] [--connector ID --connector-root PRESTAGED_PREFIX --claude-executable FILE --claude-state DEDICATED_DIR]\nNo model calls occur without --run and an explicit model selection.",
    );
    return;
  }
  assertDedicatedAuthInvocation(args);
  assertTuiHistoryInvocation(args);
  const dedicatedAuth = args.includes("--dedicated-auth");
  const command = value("--pi", "pi") ?? "pi";
  if (args.includes("--preflight")) {
    assertPreflightInvocation(args);
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const result = await runConnectorPreflight(repository, {
        connector: value("--connector") ?? "",
        connectorRoot: value("--connector-root") ?? "",
        executable: value("--claude-executable"),
        pi: command,
        timeoutMs: Number(value("--timeout", "120")) * 1000,
        results: value("--results"),
        signal: abort.signal,
      });
      console.log(
        `${result.report.status}: ${value("--connector")} — free load preflight, not a compatibility pass`,
      );
      console.log(`Evidence: ${result.directory}/preflight.json`);
      if (result.report.status !== "loaded") process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    return;
  }
  const terminal = args.includes("--tui");
  if (terminal)
    assertTuiInvocation({
      run: args.includes("--run"),
      models: value("--model")?.split(","),
      cases: value("--case")?.split(","),
      mode: value("--mode"),
      attempts: Number(value("--attempts", "1")),
      stdinIsTTY: process.stdin.isTTY,
      stdoutIsTTY: process.stdout.isTTY,
    });
  if (args.includes("--list-connectors")) {
    for (const connector of connectorCatalog)
      console.log(
        `${connector.id} ${connector.package}@${connector.version} ${connector.provider} auth=${connector.auth}${connector.unavailable ? " unavailable: " + connector.unavailable : ""}`,
      );
    return;
  }
  if (
    !value("--connector") &&
    ["--connector-root", "--claude-state", "--claude-executable"].some((flag) => value(flag))
  )
    throw Error("Connector-specific options require --connector");
  if (args.filter((arg) => arg === "--connector").length > 1)
    throw Error("Select exactly one connector per invocation");
  if (args.includes("--list")) {
    for (const task of capabilityCases)
      console.log(`${task.id} [${task.modes.join(",")}] ${task.capabilities.join(", ")}`);
    return;
  }
  if (args.includes("--record-contracts")) {
    await json(path.join(directory, "contracts.json"), await toolInventory(repository, command));
    execFileSync("pnpm", ["exec", "oxfmt", "--write", path.join(directory, "contracts.json")], {
      cwd: repository,
      stdio: "inherit",
    });
    console.log(
      "Recorded structural contracts. Review the diff; this does not run or approve paid cases.",
    );
    return;
  }
  const inventory = await coverage(command);
  if (!args.includes("--run")) return;
  const runtime = await piRuntime(command);
  if (
    ![
      "/usr/",
      "/opt/",
      path.join(os.homedir(), ".local/bin") + path.sep,
      path.join(os.homedir(), ".local/lib") + path.sep,
    ].some((mount) => runtime.cli.startsWith(mount))
  )
    throw Error(
      "Paid runs need an installed Pi inside the read-only system toolchain mounts. Use --pi to select it.",
    );
  const roster = JSON.parse(await readFile(path.join(directory, "models.json"), "utf8")) as {
    models: Profile[];
  };
  const selected = value("--model")?.split(",");
  if (!selected?.length) throw Error("--run requires an explicit --model profile selection");
  const profiles = selected.map((id) => {
    const profile = roster.models.find((model) => model.id === id);
    if (!profile) throw Error(`Unknown profile: ${id}`);
    return profile;
  });
  const firstProfile = profiles[0];
  if (!firstProfile) throw Error("Select at least one model profile");
  let connectorRun: ConnectorRun | undefined;
  const connectorId = value("--connector");
  if (connectorId) {
    if (profiles.length !== 1) throw Error("Connector runs require exactly one model profile");
    const definition = connectorCatalog.find((entry) => entry.id === connectorId);
    if (!definition) throw Error(`Unknown connector: ${connectorId}`);
    assertDedicatedAuthInvocation(args, definition.auth);
    connectorRun = {
      id: connectorId,
      piAuthDir: value("--auth-dir"),
      claudeState: value("--claude-state"),
    };
    try {
      if (definition.unavailable) throw new ConnectorUnavailable(definition.unavailable);
      const stagedRoot = value("--connector-root");
      if (!stagedRoot)
        throw new ConnectorUnavailable("An explicit pre-staged --connector-root is required");
      connectorRun.prepared = await prepareConnector(
        connectorId,
        stagedRoot,
        firstProfile.model,
        value("--claude-executable"),
      );
      if (definition.auth === "claude" ? !connectorRun.claudeState : !connectorRun.piAuthDir)
        throw new ConnectorUnavailable("An explicit dedicated authentication snapshot is required");
    } catch (error) {
      connectorRun.unavailable = String(error);
    }
  }
  const names = value("--case")?.split(",");
  const tasks = capabilityCases.filter((task) => !names || names.includes(task.id));
  if (!tasks.length || names?.some((id) => !tasks.some((task) => task.id === id)))
    throw Error("Unknown or empty case selection");
  const mode = value("--mode");
  if (mode && !["direct", "codemode"].includes(mode))
    throw Error("Mode must be direct or codemode");
  if (terminal && !tasks.every((task) => task.modes.includes(mode ?? "")))
    throw Error("The selected TUI case does not support this --mode");
  const attemptsCount = Number(value("--attempts", "1"));
  const timeoutMs = Number(value("--timeout", "180")) * 1000;
  if (
    !Number.isSafeInteger(attemptsCount) ||
    attemptsCount < 1 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1000
  )
    throw Error("Invalid attempt count or timeout");
  const root = path.resolve(
    value(
      "--results",
      path.join(
        repository,
        ".tmp/capability-results",
        new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID().slice(0, 8),
      ),
    ) ?? "",
  );
  await mkdir(path.dirname(root), { recursive: true });
  await mkdir(root);
  const parent = await mkdtemp(path.join(repository, ".tmp/capability-run-"));
  const attempts: Attempt[] = [];
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let manifest: unknown = {
    inventory,
    profiles,
    piVersion: runtime.version,
    surface: terminal ? "tui" : "json",
    historyInspection: args.includes("--tui-history")
      ? { networkDisabled: true, prompt: false, timeoutMs }
      : undefined,
    terminalOutput: terminal
      ? "Native stdout/stderr inherited without capture or live redaction; screenshots are separate evidence"
      : undefined,
    authentication: {
      refresh: connectorRun?.prepared?.definition.claudeFileAuth
        ? "dedicated-private-claude-file-only"
        : dedicatedAuth
          ? "dedicated-private-login-only"
          : "snapshot-access-only",
      personalWrites: "forbidden",
      dedicatedLogin: dedicatedAuth || connectorRun?.prepared?.definition.claudeFileAuth === true,
    },
    connector: connectorEvidence(connectorRun),
    started: new Date().toISOString(),
    cases: tasks.map((task) => task.id),
    attempts: attemptsCount,
    timeoutMs,
  };
  try {
    if (connectorRun?.prepared && !connectorRun.unavailable) {
      try {
        const connector = connectorRun.prepared;
        const frozenRoot = path.join(parent, "connector");
        await cp(connector.root, frozenRoot, {
          recursive: true,
          verbatimSymlinks: true,
          filter: (file) => path.basename(file) !== ".git",
        });
        let frozenExecutable: string | undefined;
        if (connector.executable) {
          frozenExecutable = path.join(parent, "claude");
          await cp(connector.executable, frozenExecutable);
        }
        const frozen = await prepareConnector(
          connectorRun.id,
          frozenRoot,
          firstProfile.model,
          frozenExecutable,
        );
        if (
          frozen.metadata.digest !== connector.metadata.digest ||
          frozen.metadata.executableDigest !== connector.metadata.executableDigest
        )
          throw new ConnectorUnavailable("Connector artifact changed while it was being frozen");
        connectorRun.prepared = frozen;
      } catch (error) {
        connectorRun.unavailable = String(error);
      }
    }
    const snapshot = await snapshotSource(repository, parent);
    manifest = {
      ...(manifest as object),
      connector: connectorEvidence(connectorRun),
      revision: snapshot.revision,
      sourceDigest: snapshot.digest,
    };
    await report(root, profiles, attempts, manifest);
    runAttempts: for (const profile of profiles)
      for (const task of tasks)
        for (const route of task.modes.filter((candidate) => !mode || candidate === mode))
          for (let n = 1; n <= attemptsCount && !abort.signal.aborted; n++) {
            console.log(`Running ${profile.id} / ${task.id} / ${route} / attempt ${n}`);
            const result = await attempt(
              snapshot.source,
              parent,
              root,
              task,
              profile,
              route,
              n,
              command,
              value("--auth-dir") ?? "",
              timeoutMs,
              abort.signal,
              connectorRun,
              terminal,
              dedicatedAuth,
              args.includes("--tui-history"),
            );
            attempts.push(result);
            console.log(
              `${result.status}: ${task.id} / ${route}${result.reasons.length ? " — " + result.reasons.join("; ") : ""}`,
            );
            await report(root, profiles, attempts, manifest);
            const stoppedFor = accountStopReason(result);
            if (stoppedFor) {
              manifest = { ...(manifest as object), stoppedFor, stoppedAfter: result.evidence };
              await report(root, profiles, attempts, manifest);
              break runAttempts;
            }
          }
  } finally {
    await report(root, profiles, attempts, manifest);
    await rm(parent, { recursive: true, force: true });
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    console.log(`Evidence: ${root}/matrix.md`);
  }
  if (abort.signal.aborted || attempts.some((result) => result.status !== "pass"))
    process.exitCode = 1;
}
await main();
