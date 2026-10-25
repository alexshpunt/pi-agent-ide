import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Text } from "@earendil-works/pi-tui";
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";

const tools = ["read", "search", "replace", "insert", "write", "codemode"];
const mutations = new Set(["replace", "insert", "write"]);

function inside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    // oxlint-disable-next-line repo/no-parent-paths -- defensive check against traversal, not a traversal
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Restrict this smoke's file calls to fixtures and read-only IDE source; this is not an OS sandbox. */
export function settingsSmokeGuard(
  tool: string,
  input: unknown,
  workspace: string,
  agentDir: string,
  ide: string,
): string | undefined {
  if (!tools.includes(tool)) return `Tool ${tool} is outside this settings smoke`;
  if (tool === "codemode") return undefined;
  const source =
    typeof input === "object" && input !== null ? (input as { path?: unknown }).path : undefined;
  const sources = source === undefined ? [workspace] : Array.isArray(source) ? source : [source];
  for (const item of sources) {
    if (typeof item !== "string") return "Use a concrete fixture file path";
    const reference = /^(?:[0-9a-f]{8}-|SEARCH#|RESULT#|<system-result)/i.test(item);
    if (reference) {
      if (mutations.has(tool)) return "Use a concrete fixture file path for this smoke's mutations";
      continue;
    }
    if (item.startsWith("docs:") && !mutations.has(tool)) continue;
    const local = item.startsWith("raw:") ? item.slice(4) : item;
    if (/^[a-z][a-z0-9+.-]*:/i.test(local) && !local.startsWith("file://"))
      return "Only local fixture files and docs resources are allowed";
    const file = local.startsWith("file://")
      ? fileURLToPath(local)
      : path.resolve(workspace, local);
    if (inside(file, workspace) || inside(file, agentDir)) continue;
    const sourceRoots = ["src", "docs", "skills", "package.json", "README.md"].map((name) =>
      path.join(ide, name),
    );
    if (!mutations.has(tool) && sourceRoots.some((root) => inside(file, root))) continue;
    return "Path is outside this settings smoke's allowed roots";
  }
  return undefined;
}

async function snapshot(file: string) {
  try {
    const bytes = await readFile(file);
    return {
      path: file,
      content: bytes.toString("utf8"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mtimeMs: (await stat(file)).mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, missing: true };
    throw error;
  }
}

/** Verify that IDE registration leaves native Codemode script input unchanged. */
export function probeNativeCodemodeRenderer(
  resolve: (name: string, fallback: () => ToolRenderers) => ToolRenderers | undefined,
): { nativeCodemodeUnchanged: true } {
  const marker = "SETTINGS_STARTUP_RENDER_PROBE";
  let nativeCode: unknown;
  const base: ToolRenderers = {
    renderCall: (args) => {
      nativeCode = (args as { code?: unknown }).code;
      return new Text("probe", 0, 0);
    },
    renderResult: () => new Text("probe result", 0, 0),
  };
  const renderers = resolve("codemode", () => base);
  if (renderers?.renderCall === undefined) throw new Error("Missing Codemode renderer");
  renderers.renderCall(
    { code: marker },
    {} as Parameters<NonNullable<ToolRenderers["renderCall"]>>[1],
    { expanded: false, isError: false } as Parameters<NonNullable<ToolRenderers["renderCall"]>>[2],
  );
  if (nativeCode !== marker) throw new Error("IDE altered native Codemode script input");
  return { nativeCodemodeUnchanged: true };
}

/** Run a focused Luna 6 High skill smoke; without --run, load and record the session only. */
export async function runSettingsSkillSmoke(args: readonly string[]): Promise<void> {
  const value = (name: string) => {
    const index = args.indexOf(name);
    const found = index < 0 ? undefined : args[index + 1];
    if (found === undefined || found.startsWith("--")) throw new Error(`Required ${name}`);
    return found;
  };
  const ide = path.resolve(value("--ide"));
  const workspace = path.resolve(value("--workspace"));
  const agentDir = path.resolve(value("--agent-dir"));
  const results = path.resolve(value("--results"));
  const prompt = await readFile(path.resolve(value("--prompt")), "utf8");
  const withSkill = !args.includes("--without-skill");
  const authDir = getAgentDir();
  const git = (...gitArgs: string[]) =>
    execFileSync("git", gitArgs, {
      cwd: ide,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("fetch", "origin", "develop");
  const commit = git("rev-parse", "HEAD");
  if (commit !== git("rev-parse", "origin/develop") || git("status", "--porcelain") !== "")
    throw new Error("IDE must be clean at latest origin/develop before a run");
  const manifest = JSON.parse(await readFile(path.join(ide, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  if (manifest.name !== "pi-agent-ide") throw new Error("Wrong IDE source");
  await mkdir(path.dirname(results), { recursive: true });
  await mkdir(results);
  const save = (name: string, data: unknown) =>
    writeFile(path.join(results, name), JSON.stringify(data, null, 2));
  const files = [
    path.join(workspace, ".pi/pi-agent-ide/extensions.json"),
    path.join(agentDir, "pi-agent-ide/extensions.json"),
  ];
  const before = await Promise.all(files.map(snapshot));
  await save("before.json", before);
  await writeFile(path.join(results, "prompt.txt"), prompt);
  process.chdir(workspace);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const settingsManager = SettingsManager.inMemory({
    defaultTools: tools,
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    cacheWarming: "off",
  });
  const runtime = await ModelRuntime.create({
    authPath: path.join(authDir, "auth.json"),
    modelsPath: path.join(authDir, "models.json"),
  });
  const model = runtime.getModel("openai-codex", "gpt-6-luna");
  if (model === undefined) throw new Error("Luna 6 is not available in the model catalog");
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [path.join(ide, "src/pi-agent-ide.ts")],
    additionalSkillPaths: withSkill ? [path.join(ide, "skills/configure-agent-ide")] : [],
    appendSystemPrompt: [
      `Runtime environment: PI_CODING_AGENT_DIR=${agentDir}. Only the isolated Project and Global IDE settings files are writable. Do not reload during this headless check; report any reload still needed.`,
    ],
    extensionFactories: [
      createCodemodeExtension({ mode: "on" }),
      (pi) => {
        pi.on("tool_call", (event) => {
          const reason = settingsSmokeGuard(event.toolName, event.input, workspace, agentDir, ide);
          return reason === undefined ? undefined : { block: true, reason };
        });
      },
    ],
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: workspace,
    agentDir,
    settingsManager,
    modelRuntime: runtime,
    model,
    thinkingLevel: "high",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(workspace),
    tools,
  });
  const started = Date.now();
  let status = "preflight";
  let error: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const events = path.join(results, "events.jsonl");
  session.subscribe((event) => {
    if (
      ["tool_execution_start", "tool_execution_end", "message_end", "agent_settled"].includes(
        event.type,
      )
    )
      pending = pending.then(() => appendFile(events, `${JSON.stringify(event)}\n`));
  });
  try {
    await session.bindExtensions({});
    if (extensionsResult.errors.length > 0)
      throw new Error(JSON.stringify(extensionsResult.errors));
    await save("metadata.json", {
      ide,
      version: manifest.version,
      commit,
      piVersion: VERSION,
      runnerSha256: createHash("sha256")
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest("hex"),
      provider: session.model?.provider,
      model: session.model?.id,
      thinking: session.thinkingLevel,
      workspace,
      agentDir,
      withSkill,
      skillPaths: loader.getSkills().skills.map((skill) => skill.filePath),
      extensionPaths: extensionsResult.extensions.map((extension) => extension.path),
      tools: session.getActiveToolNames(),
      startedAt: new Date(started).toISOString(),
    });
    // Check native input preservation, not IDE panel presentation or a human viewport.
    await save(
      "startup.json",
      probeNativeCodemodeRenderer((name, fallback) =>
        session.extensionRunner.resolveToolRenderers(name, fallback),
      ),
    );
    await writeFile(path.join(results, "system-prompt.txt"), session.systemPrompt);
    if (args.includes("--run")) {
      status = "running";
      timeout = setTimeout(() => {
        status = "timed_out";
        void session.abort();
      }, 240_000);
      await session.prompt(prompt);
      const last = session.messages.findLast((message) => message.role === "assistant");
      if (status !== "timed_out") {
        status = last?.stopReason === "error" ? "model_error" : "settled";
        error = last?.errorMessage;
      }
      if (status === "model_error" || status === "timed_out") process.exitCode = 1;
    }
  } catch (caught) {
    status = "error";
    error = String(caught);
    process.exitCode = 1;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await pending;
    await save("messages.json", session.messages);
    await save("after.json", await Promise.all(files.map(snapshot)));
    await save("result.json", {
      status,
      error,
      durationMs: Date.now() - started,
      response: session.getLastAssistantText(),
    });
    session.dispose();
  }
  await new Promise<void>((resolve) => {
    process.stdout.write(`${JSON.stringify({ status, error, results })}\n`, () => resolve());
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSettingsSkillSmoke(process.argv.slice(2));
  // SDK services can keep handles open after dispose; evidence and stdout are flushed above.
  process.exit(process.exitCode ?? 0);
}
