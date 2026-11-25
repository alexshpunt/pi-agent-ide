import { ResourceError, type ResourceResolver } from "pi-agent-ide/api/resource";
import { stableLinearAssetLinks } from "./asset-links.ts";
import { createAxiCommentReader } from "./collections.ts";
import type { LinearOperationBackend } from "./operation-backend.ts";

const commentBodyPattern =
  /^linear:\/\/([A-Za-z0-9_-]+)\/(issue|project|document)\/([^/?#]+)\/comment\/([0-9a-f-]{36})#body$/iu;

/** The body of the saved comment in a save_comment response, when it is that comment. */
function savedBody(data: unknown, id: string): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const row = data as Record<string, unknown>;
  return typeof row.id === "string" &&
    row.id.toLowerCase() === id.toLowerCase() &&
    typeof row.body === "string"
    ? row.body
    : undefined;
}

/** Identify the body-only source whose original lines can carry shared editor anchors. */
export function isLinearCommentBodySource(source: string): boolean {
  return commentBodyPattern.test(source);
}
/** Individual comment bodies stay separate from the discussion and retain their parent. */
export function createLinearCommentResolver(
  backend: LinearOperationBackend,
  readComment = createAxiCommentReader(),
): ResourceResolver {
  return {
    id: "linear-comment-body",
    async tryResolve(source, context) {
      const match = commentBodyPattern.exec(source);
      if (!match) return { kind: "not-handled" };
      const parentSource = source.slice(0, source.indexOf("#"));
      const snapshot = await readComment(parentSource, context.cwd, context.signal);
      let expected: string | undefined = snapshot.content;
      const current = async (
        signal?: AbortSignal,
        effect: "applied" | "not-applied" = "applied",
      ): Promise<string> => {
        if (expected !== undefined) return expected;
        try {
          return (expected = (await readComment(parentSource, context.cwd, signal)).content);
        } catch {
          throw new ResourceError("LINEAR_READBACK_UNAVAILABLE", source, effect);
        }
      };
      return {
        kind: "resolved",
        resource: {
          source,
          get sourceBytes() {
            return expected === undefined ? undefined : Buffer.from(expected);
          },
          read: async (operation) => [{ type: "text", text: await current(operation.signal) }],
          async write(blocks, operation) {
            if (blocks.length !== 1 || blocks[0].type !== "text")
              throw new ResourceError("LINEAR_TEXT_REQUIRED", source, "not-applied");
            if (
              (await readComment(parentSource, context.cwd, operation.signal)).content !==
              (await current(operation.signal, "not-applied"))
            )
              throw new ResourceError("LINEAR_STALE_CONTENT", source, "not-applied");
            let failure: ResourceError | undefined;
            let receiptData: unknown;
            try {
              const receipt = await backend.invoke(
                match[1],
                "save_comment",
                { id: match[4], body: blocks[0].text },
                context.cwd,
                operation.signal,
              );
              receiptData = receipt.data;
              if (receipt.effect !== "applied" || receipt.error)
                failure = new ResourceError(
                  receipt.error ?? "LINEAR_COMMENT_SAVE_FAILED",
                  source,
                  receipt.effect,
                );
            } catch (error) {
              if (!(error instanceof ResourceError) || error.effect !== "unknown") throw error;
              failure = error;
            }
            if (failure) {
              // A lost response after Linear saved the body is settled by a readback that
              // already shows the requested text. Nothing is resent.
              if (failure.effect === "unknown") {
                const saved = await readComment(parentSource, context.cwd, operation.signal).then(
                  (comment) => comment.content,
                  () => undefined,
                );
                if (saved !== undefined && saved === stableLinearAssetLinks(blocks[0].text)) {
                  expected = saved;
                  return;
                }
              }
              throw failure;
            }
            // The save response is Linear's saved comment; use its body for the next Read
            // instead of another lookup. Without one, the next Read fetches the comment.
            expected = savedBody(receiptData, match[4]);
          },
        },
      };
    },
  };
}
