import path from "node:path";
import type { ToolConfigLayerAccess } from "#src/api/tool-config.js";
import { remoteLocation } from "./identity.js";
import type { SshBackendRegistry } from "./registry.js";
import { SshBackendError } from "./ssh.js";

/** Read project and user-global tool settings on the selected target; no startup connection. */
export function createSshToolConfigAccess(
  registry: SshBackendRegistry,
  signal?: AbortSignal,
): ToolConfigLayerAccess {
  return {
    async paths(projectRoot, name, requestSignal = signal) {
      requestSignal?.throwIfAborted();
      const owner = registry.resolve(projectRoot);
      if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", projectRoot, "not-applied");
      // Query only configuration-directory inputs, never the whole process environment.
      const result = await owner.backend.execute(
        "python3",
        [
          "-c",
          "import json,os;print(json.dumps({'home':os.environ.get('HOME',''),'agent':os.environ.get('PI_CODING_AGENT_DIR','')}))",
        ],
        owner.location.path,
        { signal: requestSignal },
      );
      if (result.exitCode !== 0)
        throw new SshBackendError("CONFIG_ENVIRONMENT_FAILED", projectRoot, "not-applied");
      const value: unknown = JSON.parse(result.stdout.toString("utf8"));
      if (
        typeof value !== "object" ||
        value === null ||
        !("home" in value) ||
        !("agent" in value) ||
        typeof value.home !== "string" ||
        typeof value.agent !== "string" ||
        !value.home.startsWith("/")
      )
        throw new TypeError("Invalid remote configuration environment");
      const directory = value.agent.trim()
        ? path.posix.resolve(owner.location.path, value.agent.trim())
        : path.posix.join(value.home, ".pi", "agent");
      return {
        project: remoteLocation(
          owner.location.target,
          path.posix.join(owner.location.path, ".pi", "pi-agent-ide", `${name}.json`),
        ).source,
        global: remoteLocation(
          owner.location.target,
          path.posix.join(directory, "extensions", "pi-agent-ide", `${name}.json`),
        ).source,
      };
    },
    async readText(source, requestSignal = signal) {
      requestSignal?.throwIfAborted();
      const owner = registry.resolve(source);
      if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
      return (
        await owner.backend.read(owner.location.path, { signal: requestSignal })
      ).bytes.toString("utf8");
    },
  };
}
