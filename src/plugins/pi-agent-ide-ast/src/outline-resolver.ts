import { resolveCodeViewPath } from "pi-agent-ide/api/code-view";

// A static import keeps the outline code from the version this Pi loaded.
import * as AstOutline from "./ast/outline.ts";
import { MAX_SOURCE_BYTES } from "./ast/read-text.ts";
import type {
  ResourceResolutionAttempt,
  ResourceResolver,
  ResourceResolverContext,
} from "pi-agent-resource";

/** Acquire original text through its resource owner; never reinterpret a URI as a local path. */
export type AstOutlineSourceReader = (
  source: string,
  context: ResourceResolverContext,
) => Promise<{ source: string; lines: readonly string[] }>;

let defaultManager: AstOutline.AstOutlineManager | undefined;

export function createAstOutlineResolver(
  manager?: AstOutline.AstOutlineManager,
  readSource?: AstOutlineSourceReader,
): ResourceResolver {
  return {
    id: "outline",
    tryResolve(source, context) {
      return Promise.resolve(resolveAstOutlineSource(source, context, manager, readSource));
    },
  };
}

function resolveAstOutlineSource(
  source: string,
  context: ResourceResolverContext,
  manager: AstOutline.AstOutlineManager | undefined,
  readSource: AstOutlineSourceReader | undefined,
): ResourceResolutionAttempt {
  let filePath: string;

  try {
    filePath = resolveCodeViewPath(source, context.cwd);
  } catch (error) {
    return { kind: "failed", error };
  }

  return {
    kind: "resolved",
    resource: {
      // Reserve the physical owner; the AST presentation remains read-only.
      source: filePath,
      link: filePath,
      async read({ signal }) {
        signal?.throwIfAborted();
        const outlineManager = manager ?? (defaultManager ??= new AstOutline.AstOutlineManager());
        let outline;
        if (readSource !== undefined) {
          const snapshot = await readSource(filePath, { ...context, signal });
          if (Buffer.byteLength(snapshot.lines.join("\n")) > MAX_SOURCE_BYTES)
            throw new Error("File exceeds the 262144-byte AST outline limit.");
          if (snapshot.lines.some((line) => line.includes("\0")))
            throw new Error("Binary resources cannot be read as AST outlines.");
          outline = await outlineManager.readDocumentOutline(
            snapshot.source,
            context.cwd,
            snapshot.lines,
          );
        } else {
          if (filePath.startsWith("ssh://"))
            throw new Error("No outline snapshot owner for this resource.");
          outline = await outlineManager.readFileOutline(filePath, context.cwd);
        }
        signal?.throwIfAborted();
        if (outline.status === "failed")
          throw new Error(outline.error ?? "Could not produce an outline.");
        return [AstOutline.formatAstOutline(outline)];
      },
    },
  };
}
