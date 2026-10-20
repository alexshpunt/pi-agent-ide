import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import {
  stageClaudeAuthentication,
  stageDedicatedClaudeFileAuthentication,
  stagePiAuthentication,
  type StagedAuthentication,
} from "./auth.ts";
import os from "node:os";
import path from "node:path";

/** A pinned connector under test, never a package-install instruction. */
export interface ConnectorDefinition {
  id: string;
  package: string;
  version: string;
  provider: string;
  /** Actual Pi credential owner when the model provider delegates authentication. */
  authProvider?: string;
  auth: "pi" | "claude" | "separate";
  /** Only the pinned file-reading adapter gets a writable dedicated Claude credential file. */
  claudeFileAuth?: boolean;
  extensions: string[];
  /** Concrete files when the manifest declares directories; Pi -e requires files. */
  entrypoints?: string[];
  cli?: boolean;
  aliases?: boolean;
  revision?: string;
  unavailable?: string;
}

/** The requested inventory includes historical targets; unavailable never means passed. */
export const connectorCatalog: ConnectorDefinition[] = [
  {
    id: "subscription",
    package: "pi-claude-subscription",
    version: "0.2.4",
    provider: "claude-sdk",
    auth: "claude",
    cli: true,
    extensions: ["src/index.ts"],
  },
  {
    id: "bridge",
    package: "pi-claude-bridge",
    version: "0.9.3",
    provider: "claude-bridge",
    auth: "claude",
    cli: true,
    extensions: ["src/index.ts"],
  },
  {
    id: "saccolabs-cli",
    package: "@saccolabs/pi-claude-cli",
    version: "0.10.0",
    provider: "pi-claude-cli",
    auth: "claude",
    cli: true,
    extensions: ["index.ts"],
  },
  {
    id: "agent-sdk",
    package: "pi-claude-agent-sdk",
    version: "0.9.2",
    provider: "claude-bridge",
    authProvider: "anthropic",
    auth: "pi",
    cli: true,
    extensions: ["src/index.ts"],
  },
  {
    id: "legacy-agent-sdk",
    package: "claude-agent-sdk-pi",
    version: "1.0.22",
    provider: "claude-agent-sdk",
    auth: "claude",
    cli: true,
    extensions: ["index.ts"],
    unavailable: "Declared Pi ^0.74.0 peers exclude this runner's Pi 1.x runtime.",
  },
  {
    id: "subscription-connector",
    package: "pi-claude-subscription-connector",
    version: "1.2.0",
    provider: "anthropic",
    auth: "pi",
    aliases: true,
    extensions: ["extensions"],
    entrypoints: ["extensions/subscription-guard.ts", "extensions/usage-status.ts"],
  },
  {
    id: "benvargas",
    package: "@benvargas/pi-claude-code-use",
    version: "2.2.1",
    provider: "anthropic",
    auth: "pi",
    aliases: true,
    extensions: ["extensions/index.ts"],
  },
  {
    id: "zgltyq",
    package: "@zgltyq/pi-provider-claude",
    version: "1.3.4",
    provider: "anthropic",
    auth: "pi",
    extensions: ["index.ts"],
  },
  {
    id: "gotgenes",
    package: "@gotgenes/pi-anthropic-auth",
    version: "3.4.3",
    provider: "anthropic",
    auth: "pi",
    extensions: ["src/index.ts"],
  },
  {
    id: "adeildo",
    package: "@adeildo/pi-providers",
    version: "5.11.1",
    provider: "anthropic",
    auth: "pi",
    extensions: ["src/index.ts"],
  },
  {
    id: "pro",
    package: "pi-claude-pro",
    version: "1.1.0",
    provider: "anthropic",
    auth: "pi",
    extensions: ["extensions/index.ts"],
  },
  {
    id: "max",
    package: "pi-claude-max",
    version: "1.1.2",
    provider: "anthropic",
    auth: "pi",
    extensions: ["index.ts"],
  },
  {
    id: "oauth-adapter",
    package: "pi-claude-oauth-adapter",
    version: "0.2.2",
    provider: "anthropic",
    auth: "pi",
    extensions: ["extensions/index.ts"],
  },
  {
    id: "request-compat",
    package: "pi-claude-request-compat",
    version: "0.2.1",
    provider: "claude-compat",
    auth: "separate",
    extensions: ["src/extension.js"],
  },
  {
    id: "cgaravitoq",
    package: "@cgaravitoq/pi-claude-code-auth",
    version: "2.8.0",
    provider: "claude-code",
    auth: "claude",
    extensions: ["src/index.ts"],
  },
  {
    id: "claude-auth",
    package: "pi-claude-auth",
    version: "0.1.3",
    provider: "anthropic",
    auth: "claude",
    claudeFileAuth: true,
    extensions: ["src/index.ts"],
  },
  {
    id: "anthropic-oauth",
    package: "pi-anthropic-oauth",
    version: "0.3.1",
    provider: "anthropic",
    auth: "pi",
    extensions: ["src/index.ts"],
  },
  {
    id: "sub-anthropic",
    package: "pi-sub-anthropic",
    version: "0.1.10",
    provider: "pi-sub-anthropic",
    auth: "separate",
    extensions: ["index.ts"],
  },
  {
    id: "plan",
    package: "pi-claude-plan",
    version: "1.8.6",
    provider: "claude-plan",
    auth: "separate",
    extensions: ["index.ts"],
  },
  {
    id: "legacy-code-provider",
    package: "pi-claude-code-provider",
    version: "0.6.0",
    provider: "pi-claude-code-provider",
    auth: "claude",
    cli: true,
    extensions: ["index.ts"],
  },
  {
    id: "rchern-cli",
    package: "pi-claude-cli",
    version: "0.3.1",
    revision: "e0c9a12ac21be4c197e82795f7207746f3183028",
    provider: "pi-claude-cli",
    auth: "claude",
    cli: true,
    extensions: ["index.ts"],
    unavailable:
      "Uses @mariozechner Pi ^0.52.0 peers and activates all registered tools; no compatibility shim is permitted.",
  },
];

/** An unavailable prerequisite remains distinct from a model or IDE failure. */
export class ConnectorUnavailable extends Error {}

/** Verified code paths stay private to the runner; only metadata is persisted as evidence. */
export interface PreparedConnector {
  definition: ConnectorDefinition;
  root: string;
  extensions: string[];
  packagePath: string;
  executable?: string;
  metadata: {
    id: string;
    package: string;
    version: string;
    revision?: string;
    digest: string;
    executableDigest?: string;
  };
}

function within(root: string, file: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}

async function hashFile(hash: ReturnType<typeof createHash>, file: string): Promise<void> {
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
}
/** Hash package code and the resolved dependency tree without following host symlinks. */
async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(relative: string): Promise<void> {
    const full = path.join(root, relative);
    const entry = await lstat(full);
    const name = path.basename(relative);
    if (["auth.json", ".credentials.json", ".npmrc", ".env"].includes(name))
      throw new ConnectorUnavailable(
        "Connector staging contains authentication or personal configuration",
      );
    hash.update(relative).update("\0");
    if (entry.isSymbolicLink()) {
      const target = await realpath(full);
      const link = await readlink(full);
      if (within(root, target) && path.isAbsolute(link))
        throw new ConnectorUnavailable(
          "Absolute internal dependency links cannot be frozen safely",
        );
      if (!within(root, target))
        throw new ConnectorUnavailable("Connector dependency symlink escapes its staged root");
      hash.update("symlink\0").update(link);
    } else if (entry.isDirectory()) {
      for (const child of (await readdir(full)).sort())
        if (child !== ".git") await visit(path.join(relative, child));
    } else if (entry.isFile()) await hashFile(hash, full);
    else
      throw new ConnectorUnavailable("Connector staging contains an unsupported filesystem object");
    hash.update("\0");
  }
  await visit("");
  return hash.digest("hex");
}

/** Verify an explicit self-contained node_modules prefix. This never installs or logs in. */
export async function prepareConnector(
  id: string,
  stagedRoot: string,
  model: string,
  selectedExecutable?: string,
): Promise<PreparedConnector> {
  const definition = connectorCatalog.find((entry) => entry.id === id);
  if (!definition) throw new ConnectorUnavailable(`Unknown connector: ${id}`);
  if (definition.unavailable) throw new ConnectorUnavailable(definition.unavailable);
  if (!model.startsWith(definition.provider + "/"))
    throw new ConnectorUnavailable("Selected model provider differs from the connector provider");
  const root = await realpath(stagedRoot);
  if (
    root === os.homedir() ||
    within(path.join(os.homedir(), ".pi"), root) ||
    within(path.join(os.homedir(), ".claude"), root)
  )
    throw new ConnectorUnavailable(
      "Connector code must be staged outside the personal Pi and Claude directories",
    );
  const packageRoot = await realpath(path.join(root, "node_modules", definition.package));
  if (!within(root, packageRoot))
    throw new ConnectorUnavailable("Selected package escapes the staged root");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    pi?: { extensions?: string[] };
  };
  if (manifest.name !== definition.package || manifest.version !== definition.version)
    throw new ConnectorUnavailable("Staged package does not match the pinned package name/version");
  const entries = manifest.pi?.extensions?.map((entry) => entry.replace(/^\.\//, ""));
  if (JSON.stringify(entries) !== JSON.stringify(definition.extensions))
    throw new ConnectorUnavailable("Staged extension entrypoints differ from the pinned manifest");
  const entrypoints = definition.entrypoints ?? definition.extensions;
  for (const entry of [...definition.extensions, ...entrypoints])
    if (!within(packageRoot, await realpath(path.join(packageRoot, entry))))
      throw new ConnectorUnavailable("Connector entrypoint escapes its package root");
  for (const entry of entrypoints)
    if (!(await stat(path.join(packageRoot, entry))).isFile())
      throw new ConnectorUnavailable("A concrete connector entrypoint must be a regular file");
  if (definition.revision) {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: packageRoot,
      encoding: "utf8",
    }).trim();
    if (revision !== definition.revision)
      throw new ConnectorUnavailable(
        "Staged Git revision differs from the pinned connector revision",
      );
  }
  const packagePath = path.posix.join("/connector", path.relative(root, packageRoot));
  let executable: string | undefined;
  let executableDigest: string | undefined;
  if (definition.cli) {
    if (!selectedExecutable)
      throw new ConnectorUnavailable("An explicit Claude executable is required");
    executable = await realpath(selectedExecutable);
    const file = await stat(executable);
    if (!file.isFile() || !(file.mode & 0o111))
      throw new ConnectorUnavailable(
        "Selected Claude executable is not an executable regular file",
      );
    const hash = createHash("sha256");
    await hashFile(hash, executable);
    executableDigest = hash.digest("hex");
  } else if (selectedExecutable)
    throw new ConnectorUnavailable("This connector does not use the selected Claude executable");
  return {
    definition,
    root,
    extensions: entrypoints.map((entry) => path.posix.join(packagePath, entry)),
    packagePath,
    executable,
    metadata: {
      id,
      package: definition.package,
      version: definition.version,
      revision: definition.revision,
      digest: await treeDigest(root),
      executableDigest,
    },
  };
}

/** Stage the selected isolated auth route; only explicit file-auth adapters receive refreshable files. */
export function stageConnectorState(
  connector: PreparedConnector,
  state: string,
  inputs: { piAuthDir?: string; claudeState?: string },
  timeoutMs: number,
): Promise<StagedAuthentication> {
  if (connector.definition.claudeFileAuth)
    return stageDedicatedClaudeFileAuthentication(
      state,
      connector.definition.provider,
      inputs.claudeState,
    );
  return connector.definition.auth === "claude"
    ? stageClaudeAuthentication(state, connector.definition.provider, inputs.claudeState, timeoutMs)
    : stagePiAuthentication(
        state,
        connector.definition.authProvider ?? connector.definition.provider,
        inputs.piAuthDir,
        timeoutMs,
        true,
      );
}

/** Extra connector processes receive only explicit private paths and bounded one-shot behavior. */
export function connectorEnvironment(connector: PreparedConnector): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: "/state/home/.claude",
    CAPABILITY_CONNECTOR_ALIASES: connector.definition.aliases ? "1" : "0",
    CAPABILITY_CONNECTOR_PACKAGE: connector.packagePath,
    PI_CLAUDE_SDK_CLAUDE_PATH: "/tools/claude",
    PI_CLAUDE_CODE_PROVIDER_PATH: "/tools/claude",
    PI_CLAUDE_CODE_PROVIDER_WEB_SEARCH: "off",
    PI_CLAUDE_CLI_KEEPALIVE_MS: "0",
    PI_CLAUDE_CLI_EPHEMERAL: "1",
  };
}
