import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BuiltinExtensionContext } from "#src/composite/selection.js";
import {
  registerVisionWithOwner,
  type ProcessOwnerAccess,
  type CaptureOwnerAccess,
} from "#src/plugins/pi-agent-ide-vision/index.js";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.js";
import { readSshTargets, resolveSshConfigPaths } from "./config.js";
import { SshBackendRegistry } from "./registry.js";
import { SshBackendError } from "./ssh.js";
import { readSshProcessMetadata } from "./process-metadata.js";
import { captureSshFrame } from "./vision-capture.js";
import { parseSshWebSource } from "./web-owner.js";
import { captureSshBrowserImage } from "./web-browser.js";

/** Add explicit target process namespaces without changing ordinary local discovery or capture. */
export function createSshProcessOwner(registry: SshBackendRegistry): ProcessOwnerAccess {
  return {
    async read(source, signal) {
      if (!source.startsWith("process:ssh://")) return undefined;
      const uri = new URL(source.slice("process:".length));
      if (
        uri.username ||
        uri.password ||
        uri.port ||
        uri.search ||
        uri.hash ||
        !/^\/[1-9][0-9]*$/u.test(uri.pathname)
      )
        throw new SshBackendError("INVALID_SOURCE", source, "not-applied");
      try {
        const [metadata] = await readSshProcessMetadata(
          registry,
          `ssh://${uri.hostname}/`,
          Number(uri.pathname.slice(1)),
          signal,
        );
        if (!metadata) throw new SshBackendError("ENOENT", source, "not-applied");
        return metadata;
      } catch (error) {
        if (error instanceof SshBackendError)
          throw new SshBackendError(error.code, source, error.effect);
        throw error;
      }
    },
    async list(scope, signal) {
      if (!scope.startsWith("ssh://")) return undefined;
      return readSshProcessMetadata(registry, scope, undefined, signal);
    },
  };
}

/** Bridge authorized target snapshots to native pixel acquisition; local capture is never used. */
export function createSshCaptureOwner(registry: SshBackendRegistry): CaptureOwnerAccess {
  return {
    captureWindow(source, process, signal) {
      if (!process.executable)
        throw new SshBackendError("CAPABILITY_UNAVAILABLE", source, "not-applied");
      return captureSshFrame(
        registry,
        source,
        {
          kind: "window",
          pid: process.pid,
          identity: process.identity,
          executable: process.executable,
        },
        signal,
      );
    },
    async captureWeb(source, signal) {
      const parsed = parseSshWebSource(source);
      if (!parsed) throw new SshBackendError("INVALID_SOURCE", source, "not-applied");
      try {
        const owner = registry.resolve(`ssh://${parsed.target}/`);
        if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
        return await captureSshBrowserImage(owner.backend.target, parsed.url, source, signal);
      } catch (error) {
        if (error instanceof SshBackendError)
          throw new SshBackendError(error.code, source, error.effect);
        throw error;
      }
    },
    captureDisplay(source, index, signal) {
      return captureSshFrame(registry, source, { kind: "display", index }, signal);
    },
  };
}
/** Register enabled vision/process providers lazily; unused targets launch no probes. */
export default async function registerOwnedVision(
  pi: ExtensionAPI,
  context?: BuiltinExtensionContext,
): Promise<void> {
  const registry = new SshBackendRegistry(
    await readSshTargets(resolveSshConfigPaths(resolvePiAgentIdeExtensionsConfigPaths())),
  );
  await registerVisionWithOwner(
    pi,
    context,
    createSshProcessOwner(registry),
    createSshCaptureOwner(registry),
  );
}
