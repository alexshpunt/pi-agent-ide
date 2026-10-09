import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { PiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.js";
import { SshBackend, type SshTarget } from "./ssh.js";

const settingsSchema = Type.Object(
  {
    targets: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          host: Type.String(),
          workspace: Type.String(),
          configFile: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** SSH settings use a separate ssh.json beside each extension settings file. */
export function resolveSshConfigPaths(
  paths: PiAgentIdeExtensionsConfigPaths,
): PiAgentIdeExtensionsConfigPaths {
  return {
    globalPath: path.join(path.dirname(paths.globalPath), "ssh.json"),
    projectPath: path.join(path.dirname(paths.projectPath), "ssh.json"),
  };
}

/** Merge explicitly configured targets by ID; project records replace complete global records. */
export async function readSshTargets(
  paths: PiAgentIdeExtensionsConfigPaths,
): Promise<readonly SshTarget[]> {
  const global = await readScope(paths.globalPath);
  const project = await readScope(paths.projectPath);
  const targets = new Map(global.map((target) => [target.id, target]));
  for (const target of project) targets.set(target.id, target);
  return [...targets.values()];
}

async function readScope(filename: string): Promise<readonly SshTarget[]> {
  let source: string;
  try {
    source = await readFile(filename, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return [];
    throw new Error(`Cannot read SSH settings at ${filename}`, { cause: error });
  }
  try {
    const settings: unknown = JSON.parse(source);
    if (!Value.Check(settingsSchema, settings)) throw new Error("Invalid settings");
    return validateScope(settings, filename);
  } catch {
    // Do not include invalid field values: users may accidentally place secrets here.
    throw new Error(`Invalid SSH settings at ${filename}`);
  }
}

function validateScope(
  settings: Static<typeof settingsSchema>,
  filename: string,
): readonly SshTarget[] {
  const ids = new Set<string>();
  return settings.targets.map((target) => {
    if (ids.has(target.id)) throw new Error("Duplicate target");
    ids.add(target.id);
    const configured: SshTarget = {
      id: target.id,
      host: target.host,
      workspace: target.workspace,
      ...(target.configFile === undefined
        ? {}
        : { configFile: path.resolve(path.dirname(filename), target.configFile) }),
    };
    // Construction only validates; it never probes SSH or reads credentials.
    return new SshBackend(configured).target;
  });
}
