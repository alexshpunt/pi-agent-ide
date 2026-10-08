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
  checkCoverage,
  parseEvents,
  validateRoute,
  type CapabilityCase,
  type RunEvent,
} from "./validation.ts";
import { piRuntime, toolInventory, type Inventory } from "./inventory.ts";
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
}
interface Attempt {
  case: string;
  mode: string;
  model: string;
  status: string;
  reasons: string[];
  evidence: string;
}
const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = findRepositoryRoot(import.meta.url);
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const flags = new Set(["--help", "--list", "--check", "--record-contracts", "--run"]);
const options = new Set([
  "--model",
  "--case",
  "--mode",
  "--attempts",
  "--timeout",
  "--results",
  "--pi",
  "--auth-dir",
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
): Promise<Attempt> {
  const evidence = `${profile.id}--${task.id}--${mode}--${number}`;
  const artifacts = path.join(root, evidence);
  await mkdir(artifacts);
  const result: Attempt = {
    case: task.id,
    mode,
    model: profile.id,
    status: "infra_error",
    reasons: [],
    evidence,
  };
  let prepared: Awaited<ReturnType<typeof prepareTrial>> | undefined;
  try {
    prepared = await prepareTrial(parent, source, task);
    const bwrap = await sandboxArgs(source, prepared.root);
    const env = {
      PATH: ["/usr/local/bin", "/usr/bin", "/bin", path.join(os.homedir(), ".local/bin")].join(
        path.delimiter,
      ),
      PYTHONUSERBASE: path.join(os.homedir(), ".local"),
      HOME: "/state/home",
      PI_CODING_AGENT_DIR: "/state/agent",
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
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
    for (const file of ["auth.json", "models.json"]) {
      try {
        await cp(path.join(authDir, file), path.join(prepared.state, "agent", file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await json(path.join(prepared.state, "agent/settings.json"), {
      codemode: { mode: "on" },
      defaultTools: [
        "read",
        "write",
        "bash",
        "search",
        "select",
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
      retry: { enabled: true, maxRetries: 3 },
    });
    const taskPrompt = prompt(task, mode);
    await writeFile(path.join(artifacts, "prompt.txt"), taskPrompt);
    const cli = await piRuntime(command);
    const piArgs = [
      "--approve",
      "--offline",
      "--no-session",
      "--mode",
      "json",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "-e",
      "/source/src/pi-agent-ide.ts",
      "-e",
      "/source/benchmarks/tool-capabilities/observer.ts",
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
      "--pi-agent-ide-no-post-processing",
      "true",
    ];
    if (task.setup === "write-hook")
      piArgs.push("-e", "/source/tests/integration/support/user-hooks-extension.ts");
    if (task.setup === "move-rollback")
      piArgs.push("-e", "/source/benchmarks/tool-capabilities/move-rollback-fixture.ts");
    if (task.setup === "move-effects")
      piArgs.push(
        "-e",
        "/source/src/extensions/pi-agent-text-editor/test/fixtures/move-effects-probe.ts",
      );
    if (task.setup === "display")
      piArgs.push(
        "--pi-agent-ide-vision-displays",
        "true",
        "--pi-agent-ide-vision-arbitrary-windows",
        "true",
      );
    let launch = "";
    if (task.setup === "web")
      launch +=
        "node -e " +
        shellQuote(
          'require("http").createServer((req,res)=>{res.setHeader("Content-Type","text/html");res.end("<title>WEB-MARKER</title><main>WEB-MARKER</main>")}).listen(8765,"127.0.0.1")',
        ) +
        " &\nsleep 0.5\n";
    if (task.setup === "display")
      launch +=
        "export DISPLAY=:127\nXvfb :127 -screen 0 800x600x24 >/state/xvfb.log 2>&1 &\nsleep 0.5\nxmessage -name CAPABILITY-WINDOW CAPABILITY-WINDOW >/state/window.log 2>&1 &\nsleep 0.5\n";
    launch += ["node", cli.cli, ...piArgs, "--", taskPrompt].map(shellQuote).join(" ");
    const execution = await runProcess("bwrap", [...bwrap, "/bin/bash", "-c", launch], {
      env,
      timeoutMs,
      signal,
    });
    await writeFile(path.join(artifacts, "events.jsonl"), execution.stdout);
    await writeFile(path.join(artifacts, "stderr.log"), execution.stderr);
    const encode = (files: Record<string, Buffer>) =>
      Object.fromEntries(
        Object.entries(files).map(([file, bytes]) => [file, bytes.toString("base64")]),
      );
    await json(path.join(artifacts, "files.json"), {
      initial: encode(prepared.initial),
      final: encode(await fixtureFiles(prepared.cwd)),
    });
    try {
      await cp(path.join(prepared.state, "runtime.json"), path.join(artifacts, "runtime.json"));
    } catch {
      /* A startup failure has no runtime capture. */
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
      result.reasons.push(execution.stderr || `Pi exited ${execution.code}`);
      return result;
    }
    const events = parseEvents(execution.stdout);
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
    ) as { model: string; thinking: string };
    if (runtime.model !== profile.model || runtime.thinking !== profile.thinking) {
      result.reasons.push("Actual model/thinking differs from the requested profile");
      return result;
    }
    const route = validateRoute(task, events, mode);
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
    result.reasons.push(String(error));
    return result;
  } finally {
    if (prepared) await cleanupTrial(parent, prepared.root);
    await json(path.join(artifacts, "result.json"), result);
  }
}

async function main(): Promise<void> {
  if (args.includes("--help") || !args.length) {
    console.log(
      "Tool capability matrix (Linux/WSL, Bubblewrap)\n\nFree: --list | --check | --record-contracts (after reviewing changed tools)\nPaid: --run --model PROFILE_ID[,PROFILE_ID] [--case ID[,ID]] [--mode direct|codemode] [--attempts N] [--timeout SECONDS] [--results NEW_DIR] [--pi COMMAND] [--auth-dir DIR]\nNo model calls occur without --run and an explicit model selection.",
    );
    return;
  }
  const command = value("--pi", "pi") ?? "pi";
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
  const names = value("--case")?.split(",");
  const tasks = capabilityCases.filter((task) => !names || names.includes(task.id));
  if (!tasks.length || names?.some((id) => !tasks.some((task) => task.id === id)))
    throw Error("Unknown or empty case selection");
  const mode = value("--mode");
  if (mode && !["direct", "codemode"].includes(mode))
    throw Error("Mode must be direct or codemode");
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
    started: new Date().toISOString(),
    cases: tasks.map((task) => task.id),
    attempts: attemptsCount,
    timeoutMs,
  };
  try {
    const snapshot = await snapshotSource(repository, parent);
    manifest = {
      ...(manifest as object),
      revision: snapshot.revision,
      sourceDigest: snapshot.digest,
    };
    await report(root, profiles, attempts, manifest);
    for (const profile of profiles)
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
              value(
                "--auth-dir",
                process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent"),
              ) ?? "",
              timeoutMs,
              abort.signal,
            );
            attempts.push(result);
            console.log(
              `${result.status}: ${task.id} / ${route}${result.reasons.length ? " — " + result.reasons.join("; ") : ""}`,
            );
            await report(root, profiles, attempts, manifest);
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
