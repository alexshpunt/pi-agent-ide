import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { runConfiguredProcess } from "pi-agent-ide/api/tool-config";
import { parse } from "smol-toml";
import type {
  FormatterCommandConfig,
  ProcessConfig,
  ProcessResult,
} from "pi-agent-ide/api/tool-config";

/** The filesystem and processes must belong to the Rust source, not the controller. */
export function localRustfmtAccess(projectRoot: string, filePath: string): RustfmtAccess {
  const configHome =
    process.platform === "win32"
      ? process.env.APPDATA
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return {
    paths: path,
    userConfigDirectories: [
      os.homedir(),
      ...(configHome ? [path.join(configHome, "rustfmt")] : []),
    ],
    async readText(file) {
      try {
        return await readFile(file, "utf8");
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR")
        )
          return undefined;
        throw error;
      }
    },
    run: (config) => runConfiguredProcess(config, { projectRoot, filePath }),
  };
}
export interface RustfmtAccess {
  readonly paths: typeof path;
  readonly userConfigDirectories: readonly string[];
  readText(file: string): Promise<string | undefined>;
  run(config: ProcessConfig): Promise<ProcessResult>;
}

/** Add Cargo's package edition unless rustfmt's selected configuration sets one. */
export async function rustfmtWithEdition(
  config: FormatterCommandConfig,
  file: string,
  access: RustfmtAccess,
): Promise<FormatterCommandConfig> {
  const directories: string[] = [];
  let directory = access.paths.dirname(file);
  for (;;) {
    directories.push(directory);
    const parent = access.paths.dirname(directory);
    if (parent === directory || /^\/[A-Z]:\/?$/u.test(directory)) break;
    directory = parent;
  }
  directories.push(...access.userConfigDirectories);
  let found = false;
  for (const dir of directories) {
    for (const name of [".rustfmt.toml", "rustfmt.toml"]) {
      const text = await access.readText(access.paths.join(dir, name));
      if (text === undefined) continue;
      found = true;
      if (Object.hasOwn(parse(text), "edition")) return config;
      break;
    }
    if (found) break;
  }

  let manifest: ProcessResult;
  try {
    manifest = await access.run({
      command: ["cargo", "read-manifest", "--offline"],
      cwd: "file",
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return config;
    throw error;
  }
  if (!manifest.ok) return config;
  const value: unknown = JSON.parse(manifest.stdout);
  if (
    typeof value !== "object" ||
    value === null ||
    !("edition" in value) ||
    typeof value.edition !== "string"
  )
    return config;
  return {
    ...config,
    run: { ...config.run, command: ["rustfmt", "--edition", value.edition, "{file}"] },
  };
}
