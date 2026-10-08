import {
  formatCodeViewReference,
  parseCodeViewReference,
  resolveCodeViewPath,
} from "pi-agent-ide/api/code-view";

import type * as AstOutline from "./ast/outline.js";
import { MAX_SOURCE_BYTES } from "./ast/read-text.js";
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
let astOutlineModule: Promise<typeof AstOutline> | undefined;

export function createAstOutlineResolver(
  manager?: AstOutline.AstOutlineManager,
  readSource?: AstOutlineSourceReader,
): ResourceResolver {
  return {
    id: "ast",
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
  let reference;

  try {
    reference = parseCodeViewReference(source, "ast");
  } catch (error) {
    return { kind: "failed", error };
  }

  if (reference === undefined) {
    return { kind: "not-handled" };
  }

  let filePath: string;

  try {
    filePath = resolveCodeViewPath(reference.path, context.cwd);
  } catch (error) {
    return { kind: "failed", error };
  }

  const canonicalSource = formatCodeViewReference("ast", filePath);
  return {
    kind: "resolved",
    resource: {
      source: canonicalSource,
      async read({ signal }) {
        signal?.throwIfAborted();
        const astOutline = await (astOutlineModule ??= import("./ast/outline.js"));
        const outlineManager = manager ?? (defaultManager ??= new astOutline.AstOutlineManager());
        let outline;
        if (filePath.startsWith("ssh://")) {
          if (readSource === undefined) throw new Error("No AST snapshot owner for this resource.");
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
          outline = await outlineManager.readFileOutline(filePath, context.cwd);
        }
        signal?.throwIfAborted();
        return [astOutline.formatAstOutline(outline)];
      },
    },
  };
}
