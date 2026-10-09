import { copyFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { DoctorContext } from "pi-agent-doctor/api/plugin-protocol";
import {
  hasConfiguredExecutable,
  type ConfiguredProcessAccess,
  type ProcessConfig,
  type ToolRuntimeConfigOptions,
} from "./tool-config.js";

/** Reuse layered tool selection on the Doctor project's file and process owner. */
export function doctorRuntimeOptions(context: DoctorContext): ToolRuntimeConfigOptions {
  const workspace = context.workspace;
  return {
    environment: context.env,
    signal: context.signal,
    ...(workspace
      ? {
          layerAccess: {
            paths: (_root, name, signal) => workspace.configPaths(name, signal),
            async readText(source, signal) {
              const content = await workspace.readText(source, signal);
              if (content === undefined)
                throw Object.assign(new Error(`ENOENT: ${source}`), { code: "ENOENT" });
              return content;
            },
          },
          executableAvailability: (configs, signal) =>
            workspace.executableAvailability(configs, signal),
          recipeEvidence: (recipes, signal) => workspace.evidence(recipes, signal),
        }
      : {}),
  };
}

/** Execute a configured probe on its project owner, never on the controller. */
export function doctorProcessAccess(context: DoctorContext): ConfiguredProcessAccess | undefined {
  const workspace = context.workspace;
  return workspace
    ? { run: (config, input) => workspace.run(config, input.filePath, input.signal) }
    : undefined;
}

/** Check the configured executable through the same owner used by runtime selection. */
export async function doctorExecutableAvailable(
  context: DoctorContext,
  config: ProcessConfig,
): Promise<boolean> {
  context.signal?.throwIfAborted();
  if (!context.workspace)
    return hasConfiguredExecutable(config, context.cwd, context.env, context.signal);
  const values = await context.workspace.executableAvailability([config], context.signal);
  context.signal?.throwIfAborted();
  if (values.length !== 1 || typeof values[0] !== "boolean")
    throw new TypeError("Invalid Doctor executable availability report");
  return values[0];
}

/** Run a destructive tool probe only on an owned copy and await its removal. */
export async function withDoctorProbeCopy<T>(
  context: DoctorContext,
  source: string,
  use: (probe: string) => Promise<T>,
): Promise<T> {
  context.signal?.throwIfAborted();
  if (context.workspace) return context.workspace.withProbeCopy(source, use, context.signal);
  if (source.includes("://"))
    throw Object.assign(new Error(`Doctor requires the owner of ${source}`), {
      code: "UNSUPPORTED_SOURCE",
    });
  const directory = await mkdtemp(path.join(path.dirname(source), ".pi-agent-ide-doctor-"));
  const probe = path.join(directory, path.basename(source));
  try {
    await copyFile(source, probe);
    context.signal?.throwIfAborted();
    return await use(probe);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
