import path from "node:path";
import type { ToolConfigLayerAccess } from "#src/api/tool-config.ts";
import { remoteLocation } from "./identity.ts";
import type { SshBackendRegistry } from "./registry.ts";
import { SshBackendError } from "./ssh.ts";
import { remotePython, targetOs } from "./ssh-transport.ts";

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
      // Query only configuration-directory inputs, never the whole process environment. The
      // target resolves them with its own path rules: Windows has no HOME by default.
      const result = await owner.backend.execute(
        remotePython(
          "import json,os\nagent=os.environ.get('PI_CODING_AGENT_DIR','').strip()\nprint(json.dumps({'home':os.path.expanduser('~'),'agent':os.path.abspath(agent) if agent else ''}))",
        ),
        [],
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
        typeof value.agent !== "string"
      )
        throw new TypeError("Invalid remote configuration environment");
      const os = targetOs(owner.backend.target);
      const native = (directory: string) =>
        remoteLocation(owner.location.target, directory, os).path;
      const directory = value.agent
        ? native(value.agent)
        : path.posix.join(native(value.home), ".pi", "agent");
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
