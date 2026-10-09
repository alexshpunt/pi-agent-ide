import type {
  AgentContent,
  ContentHost,
  ResourceByteRead,
  ResourceOperationContext,
  ResourceResolver,
} from "pi-agent-resource";
import { textFromAgentContent } from "pi-agent-text";

import type { SshBackendRegistry } from "./registry.js";
import { SshBackendError } from "./ssh.js";

/** Bridge configured SSH targets to existing content hosts and read/editor resolver registries. */
export function createSshResourceResolver(
  registry: SshBackendRegistry,
  contentHost: Pick<ContentHost, "convert">,
  capability: "read" | "write",
): ResourceResolver {
  return {
    id: "ssh",
    async tryResolve(source, context) {
      try {
        const resolved = registry.resolve(source, context.cwd);
        if (!resolved) return { kind: "not-handled" };
        const { backend, location } = resolved;
        let directory = false;
        try {
          directory = (await backend.stat(location.path, context)).kind === "directory";
        } catch (error) {
          if (!(error instanceof SshBackendError) || error.code !== "ENOENT") throw error;
        }
        let version: string | null | undefined;
        let sourceBytes: Uint8Array | undefined;
        const snapshot = async (operationContext: ResourceOperationContext) => {
          try {
            const current = await backend.read(location.path, operationContext);
            version = current.version;
            return current.bytes;
          } catch (error) {
            if (error instanceof SshBackendError && error.code === "ENOENT") version = null;
            throw error;
          }
        };
        const read = async (operationContext: ResourceOperationContext): Promise<AgentContent> => {
          sourceBytes = undefined;
          if (directory) {
            const entries = await backend.list(location.path, operationContext);
            const rows = entries.map(
              (entry) =>
                `  ${entry.kind === "directory" ? "📁" : entry.kind === "file" ? "📄" : "🔗"} ${entry.name}`,
            );
            return [
              {
                type: "text" as const,
                text: [`📁 ${location.source}/`, ...(rows.length ? ["", ...rows] : [])].join("\n"),
              },
            ];
          }
          sourceBytes = await snapshot(operationContext);
          return contentHost.convert(
            { source: location.source, bytes: sourceBytes },
            operationContext,
          );
        };
        const readBytes: ResourceByteRead = async (offset, limit, operationContext) => {
          const chunkSize = 4 * 1024 * 1024;
          const first = await backend.readRange(
            location.path,
            offset,
            Math.min(limit ?? chunkSize, chunkSize),
            operationContext,
          );
          const chunks = [first.bytes];
          let length = first.bytes.length;
          const wanted = Math.min(limit ?? first.totalBytes, first.totalBytes - first.offset);
          while (length < wanted) {
            const next = await backend.readRange(
              location.path,
              first.offset + length,
              Math.min(wanted - length, chunkSize),
              operationContext,
            );
            if (
              next.revision !== first.revision ||
              next.totalBytes !== first.totalBytes ||
              next.offset !== first.offset + length
            )
              throw new SshBackendError("SOURCE_CHANGED", location.source, "not-applied");
            if (next.bytes.length === 0) break;
            chunks.push(next.bytes);
            length += next.bytes.length;
          }
          return {
            bytes: Buffer.concat(chunks, length),
            byteOffset: first.offset,
            totalBytes: first.totalBytes,
          };
        };
        if (capability === "read" || directory)
          return {
            kind: "resolved",
            resource: {
              source: location.source,
              link: location.source,
              read,
              get sourceBytes() {
                return sourceBytes;
              },
              ...(directory ? {} : { readBytes }),
            },
          };
        return {
          kind: "resolved",
          resource: {
            source: location.source,
            link: location.source,
            read,
            readBytes,
            get sourceBytes() {
              return sourceBytes;
            },
            async write(content, operationContext) {
              const text = textFromAgentContent(content);
              if (version === undefined) {
                try {
                  await snapshot(operationContext);
                } catch (error) {
                  if (!(error instanceof SshBackendError) || error.code !== "ENOENT") throw error;
                }
              }
              if (version === undefined)
                throw new SshBackendError("SNAPSHOT_REQUIRED", location.source, "not-applied");
              version = await backend.write(
                location.path,
                Buffer.from(text, "utf8"),
                version,
                operationContext,
              );
            },
          },
        };
      } catch (error) {
        return { kind: "failed", error };
      }
    },
  };
}
