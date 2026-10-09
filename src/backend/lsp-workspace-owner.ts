import type { LspWorkspaceOwner } from "#src/plugins/pi-agent-ide-lsp/index.js";
import type { SshBackendRegistry } from "./registry.js";
import { SshBackendError } from "./ssh.js";
import { createSshLspTransport } from "./lsp-transport.js";

/** Workspace reads, marker checks and stdio remain on their configured SSH owner. */
export function createSshLspWorkspaceOwner(registry: SshBackendRegistry): LspWorkspaceOwner {
  const resolve = (source: string) => {
    const owner = registry.resolve(source);
    if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
    return owner;
  };
  return {
    transport: (rootUri) => createSshLspTransport(registry, rootUri),
    async readText(source, signal) {
      const owner = resolve(source);
      return (await owner.backend.read(owner.location.path, { signal })).bytes.toString("utf8");
    },
    async readSnapshot(source, signal) {
      const owner = resolve(source);
      const snapshot = await owner.backend.read(owner.location.path, { signal });
      return { content: snapshot.bytes.toString("utf8"), version: snapshot.version };
    },
    async readBytes(source, signal) {
      const owner = resolve(source);
      return (await owner.backend.read(owner.location.path, { signal })).bytes;
    },
    async exists(source, signal) {
      const owner = resolve(source);
      try {
        await owner.backend.stat(owner.location.path, { signal });
        return true;
      } catch (error) {
        if (error instanceof SshBackendError && error.code === "ENOENT") return false;
        throw error;
      }
    },
    async isFile(source, signal) {
      const owner = resolve(source);
      return (await owner.backend.stat(owner.location.path, { signal })).kind === "file";
    },
    async entries(source, signal) {
      const owner = resolve(source);
      return (await owner.backend.list(owner.location.path, { signal })).map((entry) => ({
        name: entry.name,
        kind: entry.kind === "symlink" ? "other" : entry.kind,
      }));
    },
  };
}
