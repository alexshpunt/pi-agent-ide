import {
  ResourceError,
  type Resource,
  type ResourceResolver,
  type ResourceOperationContext,
} from "pi-agent-ide/api/resource";
import { githubResourceError } from "#github/resource-error.ts";
import { githubLocation } from "#github/environment.ts";
import type { GithubConnectionAccess, GithubConnectionBoundary } from "./manager.ts";

export function assertGithubAccess(
  access: GithubConnectionAccess | undefined,
  source: string,
): void {
  try {
    access?.assertCurrent();
  } catch {
    throw new ResourceError("GH_CONNECTION_CHANGED", source, "not-applied");
  }
}
export function githubOperationSignal(
  access: GithubConnectionAccess | undefined,
  signal?: AbortSignal,
): AbortSignal | undefined {
  return access ? (signal ? AbortSignal.any([signal, access.signal]) : access.signal) : signal;
}

/** Retained resources must use the connection that produced them, including later writes. */
export function fenceGithubResolver(
  resolver: ResourceResolver,
  boundary?: GithubConnectionBoundary,
): ResourceResolver {
  if (!boundary) return resolver;
  return {
    ...resolver,
    async tryResolve(source, context) {
      if (!githubLocation(source)?.resource) return resolver.tryResolve(source, context);
      try {
        const access = await boundary.capture(context.cwd, context.signal);
        const result = await resolver.tryResolve(source, {
          ...context,
          signal: githubOperationSignal(access, context.signal),
        });
        assertGithubAccess(access, source);
        if (result.kind !== "resolved") return result;
        const original = result.resource;
        const { read, readBytes, write } = original;
        const operation = (value: ResourceOperationContext) => ({
          ...value,
          signal: githubOperationSignal(access, value.signal),
        });
        return {
          ...result,
          resource: {
            ...original,
            ...(read
              ? {
                  async read(value: ResourceOperationContext) {
                    assertGithubAccess(access, original.source);
                    const content = await read.call(original, operation(value));
                    assertGithubAccess(access, original.source);
                    return content;
                  },
                }
              : {}),
            ...(readBytes
              ? {
                  async readBytes(
                    offset: number,
                    limit: number | undefined,
                    value: ResourceOperationContext,
                  ) {
                    assertGithubAccess(access, original.source);
                    const bytes = await readBytes.call(original, offset, limit, operation(value));
                    assertGithubAccess(access, original.source);
                    return bytes;
                  },
                }
              : {}),
            ...(write
              ? {
                  async write(
                    content: Parameters<NonNullable<Resource["write"]>>[0],
                    value: ResourceOperationContext,
                  ) {
                    assertGithubAccess(access, original.source);
                    try {
                      await write.call(original, content, operation(value));
                    } catch (error) {
                      if (error instanceof ResourceError) throw error;
                      if (access.signal.aborted)
                        throw new ResourceError(
                          "GH_CONNECTION_CHANGED",
                          original.source,
                          "unknown",
                        );
                      throw error;
                    }
                  },
                }
              : {}),
          } as Resource,
        };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        return {
          kind: "failed",
          error: githubResourceError(error, source, "GH_CONNECTION_FAILED"),
        };
      }
    },
  };
}
