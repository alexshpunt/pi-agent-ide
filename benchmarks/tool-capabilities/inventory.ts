import { execFileSync } from "node:child_process";
import { readFile, realpath, mkdtemp, rm, mkdir } from "node:fs/promises";
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
  if (command === "pi")
    candidates.push(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  for (const candidate of candidates) {
    let directory = path.dirname(await realpath(candidate));
    while (directory !== path.dirname(directory)) {
      try {
        const manifest = JSON.parse(
          await readFile(path.join(directory, "package.json"), "utf8"),
        ) as {
          name: string;
          version: string;
          bin?: { pi?: string };
        };
        if (manifest.name === "@earendil-works/pi-coding-agent" && manifest.bin?.pi)
          return {
            directory,
            sdk: path.join(directory, "dist/index.js"),
            cli: path.join(directory, manifest.bin.pi),
            version: manifest.version,
          };
      } catch {
        /* Keep looking above this entrypoint. */
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
  await mkdir(path.join(repository, ".tmp"), { recursive: true });
  const root = await mkdtemp(path.join(repository, ".tmp/capability-inventory-"));
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["read", "write", "bash"],
    codemode: { mode: "on" },
  });
  let api: ExtensionAPI | undefined;
  let session: AgentSession | undefined;
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
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    await rm(root, { recursive: true, force: true });
  }
}
