import { requiredValue } from "../../../utils/required-value.js";
import {
  type CodeViewScheme,
  formatCodeViewReference,
  parseCodeViewReference,
  resolveCodeViewPath,
  type SourceMappedTextContent,
} from "pi-agent-ide/api/code-view";

import {
  type LspManager,
  readLspFileGraph,
  readLspSymbolBody,
  readLspSymbolGraph,
} from "./lsp/index.js";

import type {
  ResourceResolutionAttempt,
  ResourceResolver,
  ResourceResolverContext,
} from "pi-agent-resource";

export type LspManagerProvider = (cwd: string) => Promise<LspManager>;

export function createLspSymbolResolver(getManager: LspManagerProvider): ResourceResolver {
  return createCodeViewResolver("symbol", "lsp-symbol", getManager, async (request) => {
    return await readLspSymbolBody(
      request.manager,
      request.filePath,
      requiredValue(request.selector),
      request.cwd,
      request.signal,
    );
  });
}

export function createLspGraphResolver(getManager: LspManagerProvider): ResourceResolver {
  return createCodeViewResolver("graph", "lsp-graph", getManager, async (request) => {
    if (request.selector === undefined) {
      return await readLspFileGraph(request.manager, request.filePath, request.cwd, request.signal);
    }

    return await readLspSymbolGraph(
      request.manager,
      request.filePath,
      request.selector,
      request.cwd,
      request.signal,
    );
  });
}

interface CodeViewReadRequest {
  readonly manager: LspManager;
  readonly filePath: string;
  readonly selector?: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

type CodeViewRead = (request: CodeViewReadRequest) => Promise<string | SourceMappedTextContent>;

function createCodeViewResolver(
  scheme: Extract<CodeViewScheme, "symbol" | "graph">,
  id: string,
  getManager: LspManagerProvider,
  read: CodeViewRead,
): ResourceResolver {
  return {
    id,
    tryResolve(source, context) {
      return Promise.resolve(resolveCodeViewSource(source, context, scheme, getManager, read));
    },
  };
}

function resolveCodeViewSource(
  source: string,
  context: ResourceResolverContext,
  scheme: Extract<CodeViewScheme, "symbol" | "graph">,
  getManager: LspManagerProvider,
  read: CodeViewRead,
): ResourceResolutionAttempt {
  let reference;

  try {
    reference = parseCodeViewReference(source, scheme);
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

  const canonicalSource = formatCodeViewReference(scheme, filePath, reference.selector);
  return {
    kind: "resolved",
    resource: {
      source: canonicalSource,
      async read(operationContext) {
        const manager = await getManager(context.cwd);
        const content = await read({
          manager,
          filePath,
          cwd: context.cwd,
          ...optionalSelector(reference.selector),
          ...optionalSignal(operationContext.signal),
        });
        return [typeof content === "string" ? { type: "text", text: content } : content];
      },
    },
  };
}

function optionalSelector(
  selector: readonly string[] | undefined,
): Pick<CodeViewReadRequest, "selector"> {
  return selector === undefined ? {} : { selector };
}

function optionalSignal(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}
