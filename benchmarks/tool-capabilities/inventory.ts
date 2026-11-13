import { execFileSync } from "node:child_process";
import { readFile, realpath, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type * as PiSdk from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { schemaShape } from "./validation.ts";

/** Structural live inventory, excluding agent-facing wording. */
export interface Inventory {
  pi: string;
  tools: { name: string; namespace: string; exposure: string; parameters: unknown }[];
}

/** Resolve an installed CLI and matching SDK, or the checkout SDK when no global CLI is present. */
export async function piRuntime(
  command = "pi",
): Promise<{ directory: string; sdk: string; cli: string; version: string }> {
  const candidates: string[] = [];
  try {
    candidates.push(
      execFileSync("which", [command], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: process.env.PATH?.split(path.delimiter)
            .filter((entry) => !entry.endsWith("/node_modules/.bin"))
            .join(path.delimiter),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    );
  } catch (error) {
    if (command !== "pi") throw error;
  }
  if (command === "pi" && candidates.length === 0)
    candidates.push(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  for (const candidate of candidates) {
    let entrypoint = await realpath(candidate);
    // pnpm's POSIX shim executes a CLI relative to its own .bin directory. Do not
    // execute or source the launcher: only accept its explicit Pi package target.
    const source = await readFile(entrypoint, "utf8");
    const target = source.match(/"\$basedir\/(\.\.\/@earendil-works\/pi-coding-agent\/[^"\n]+)"/);
    if (target?.[1]) entrypoint = await realpath(path.resolve(path.dirname(entrypoint), target[1]));
    let directory = path.dirname(entrypoint);
    while (directory !== path.dirname(directory)) {
      let manifest: { name: string; version: string; bin?: { pi?: string } } | undefined;
      try {
        manifest = JSON.parse(
          await readFile(path.join(directory, "package.json"), "utf8"),
        ) as typeof manifest;
      } catch {
        /* Keep looking above this entrypoint. */
      }
      if (manifest?.name === "@earendil-works/pi-coding-agent" && manifest.bin?.pi) {
        if (target && (await realpath(path.join(directory, manifest.bin.pi))) !== entrypoint)
          throw Error("Launcher target does not match the package CLI");
        await realpath(path.join(directory, "dist/index.js"));
        return {
          directory,
          sdk: path.join(directory, "dist/index.js"),
          cli: path.join(directory, manifest.bin.pi),
          version: manifest.version,
        };
      }
      directory = path.dirname(directory);
    }
  }
  throw Error(`Cannot find the SDK for ${command}`);
}

/** Load the IDE without a prompt or model call and collect real tool structures. */
export async function toolInventory(repository: string, command = "pi"): Promise<Inventory> {
  const runtime = await piRuntime(command);
  const sdk = (await import(pathToFileURL(runtime.sdk).href)) as typeof PiSdk;
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = sdk;
  // Keep the session outside the checkout: semantic search treats a project inside an indexed
  // parent as indexed and would add `semantic_search` on a machine where the checkout is indexed.
  const root = await mkdtemp(path.join(tmpdir(), "capability-inventory-"));
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["read", "write", "bash"],
    codemode: { mode: "on" },
  });
  let api: ExtensionAPI | undefined;
  let session: AgentSession | undefined;
  // The IDE reads its global and project settings, including `ssh.json`, from the environment
  // and the process directory, not from the session options. Point both at the empty root so a
  // developer's configured SSH targets cannot add tools such as `remote_powershell`.
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  const previousDirectory = process.cwd();
  process.env.PI_CODING_AGENT_DIR = root;
  process.chdir(root);
  try {
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [path.join(repository, "src/pi-agent-ide.ts")],
      extensionFactories: [
        (pi) => {
          api = pi;
        },
      ],
    });
    await loader.reload();
    const errors = loader.getExtensions().errors;
    if (errors.length) throw Error(JSON.stringify(errors));
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(root),
    }));
    await session.bindExtensions({});
    if (!api) throw Error("Inventory observer did not load");
    return {
      pi: runtime.version,
      tools: api
        .getAllTools()
        .filter((tool) => tool.namespace?.name.startsWith("ide_") && tool.exposure !== "hidden")
        .map((tool) => ({
          name: tool.name,
          namespace: tool.namespace?.name ?? "",
          exposure: tool.exposure,
          parameters: schemaShape(tool.parameters),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  } finally {
    process.chdir(previousDirectory);
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    await rm(root, { recursive: true, force: true });
  }
}
