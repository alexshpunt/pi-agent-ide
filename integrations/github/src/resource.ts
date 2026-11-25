import { ResourceError, type ResourceResolver } from "pi-agent-ide/api/resource";
import { githubResourceError } from "./resource-error.ts";
import { parseGithubAddress } from "./address.ts";
import type { GithubBackend, GithubApproval, GithubSnapshot } from "./backend.ts";
import { entityRoute } from "./routes.ts";
import type { GithubAssets } from "./assets.ts";

/** Resolve native cards and separate writable bodies/fields through the shared Resource contract. */
export function createGithubResolver(
  backend: GithubBackend,
  approve: GithubApproval = async () => false,
  assets?: GithubAssets,
): ResourceResolver {
  return {
    id: "github",
    async tryResolve(source, context) {
      try {
        const address = parseGithubAddress(source);
        if (!address) return { kind: "not-handled" };
        // A queued PR edit must read the body left by its predecessor. The resource
        // still belongs to the connection captured during resolution.
        const deferSnapshot =
          context.deferSnapshot === true &&
          address.facet === "body" &&
          address.parameters.size === 0 &&
          entityRoute(address)?.kind === "pull request";
        let snapshot: GithubSnapshot | undefined = deferSnapshot
          ? undefined
          : assets?.owns(address) && address.parts.at(-1) === "new"
            ? { content: assets.readSchema(address), editable: false }
            : await backend.read(address, context.cwd, context.signal);
        let initialRead: Promise<GithubSnapshot> | undefined;
        const current = async (signal?: AbortSignal): Promise<GithubSnapshot> =>
          snapshot ??
          (initialRead ??= backend.read(address, context.cwd, signal).catch((error) => {
            // A subsequent Write must not treat a failed snapshot read as a missing body.
            throw githubResourceError(error, address.source, "GH_RESOLVE_FAILED", "not-applied");
          }));
        const bytes = snapshot?.bytes;
        return {
          kind: "resolved",
          resource: {
            source: address.source,
            skipPostEdit: true,
            ...(snapshot?.editable ? { sourceBytes: Buffer.from(snapshot.content) } : {}),
            async read(operation) {
              return [{ type: "text", text: (await current(operation.signal)).content }];
            },
            ...(bytes
              ? {
                  async readBytes(offset, limit, operation) {
                    operation.signal?.throwIfAborted();
                    const start = Math.min(
                      bytes.length,
                      Math.max(0, offset < 0 ? bytes.length + offset : offset),
                    );
                    return {
                      bytes: Uint8Array.from(
                        bytes.subarray(start, start + (limit ?? bytes.length)),
                      ),
                      byteOffset: start,
                      totalBytes: bytes.length,
                    };
                  },
                }
              : {}),
            ...(deferSnapshot || snapshot?.editable
              ? {
                  async write(blocks, operation) {
                    if (blocks.length !== 1 || blocks[0].type !== "text")
                      throw new ResourceError("GH_TEXT_REQUIRED", address.source, "not-applied");
                    snapshot = await backend.save(
                      address,
                      await current(operation.signal),
                      blocks[0].text,
                      context.cwd,
                      operation.signal,
                      approve,
                    );
                  },
                }
              : {}),
          },
        };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        return { kind: "failed", error: githubResourceError(error, source, "GH_RESOLVE_FAILED") };
      }
    },
  };
}
