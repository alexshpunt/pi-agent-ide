import type {
  ReadFailure,
  ReadHandler,
  ReadPipelineContext,
  ReadStageOutcome,
  ReadTextState,
} from "pi-agent-read/api/tools/read";
import { createTextDocument } from "pi-agent-text";

import { executeJq, parseJqView } from "#src/jq.js";

export interface JqReadHandlerOptions {
  readonly pluginId: string;
  /**
   * Return immutable JSON acquired for this block, not rendered text or another read.
   * Called only after the host classifies the input as a complete source.
   */
  readonly input: (context: ReadPipelineContext) => string | undefined;
}

/**
 * Transform acquired JSON without granting original-text authority.
 * Register the jq view and scope this read-stage handler to the input provider's resolvers.
 */
export function createJqReadHandler(options: JqReadHandlerOptions): ReadHandler {
  return async (context) => {
    let selected: ReturnType<typeof parseJqView>;
    try {
      selected = parseJqView(context.request.views);
    } catch (error) {
      return failure(context, options.pluginId, "READ_FAILED", message(error));
    }
    if (selected === undefined) return { kind: "continue", context };
    if (context.inputScope === "selection" || context.sourceTarget !== undefined)
      return failure(
        context,
        options.pluginId,
        "UNSUPPORTED_RANGE",
        "jq requires a complete JSON source. Read its explicit path instead of a result, search selection or text anchor.",
      );
    if (context.inputScope !== "source")
      return failure(
        context,
        options.pluginId,
        "READ_FAILED",
        "This jq view requires a matching Read host that classifies complete source inputs.",
      );
    const state = context.state;
    if (state?.contentKind !== "text")
      return failure(
        context,
        options.pluginId,
        "UNSUPPORTED_CONTENT",
        "This source does not supply structured JSON for jq.",
      );
    // Provider failures belong to the owning Read boundary; never turn them into jq diagnostics.
    const input = options.input(context);
    if (typeof input !== "string")
      return failure(
        context,
        options.pluginId,
        "UNSUPPORTED_CONTENT",
        "This source does not supply structured JSON for jq.",
      );
    let output: string;
    try {
      output = await executeJq(selected.filter, input, {
        cwd: context.resolverContext.cwd,
        ...(context.resolverContext.signal === undefined
          ? {}
          : { signal: context.resolverContext.signal }),
      });
    } catch (error) {
      return failure(context, options.pluginId, "READ_FAILED", message(error));
    }
    const transformed: ReadTextState = {
      ...state,
      content: [{ type: "text", text: output }],
      text: createTextDocument(state.source, output),
      preserveTruncatedOutput: true,
    };
    return {
      kind: "continue",
      context: { ...context, sourceText: undefined, sourceTarget: undefined, state: transformed },
    };
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function failure(
  context: ReadPipelineContext,
  pluginId: string,
  code: ReadFailure["code"],
  message: string,
): ReadStageOutcome {
  const source = context.state?.source ?? context.request.path;
  const resolverId = context.state?.resolvedBy;
  return {
    kind: "return",
    result: {
      content: [{ type: "text", text: `jq failed: ${message}` }],
      details: {
        source,
        resolvedBy: resolverId,
        failure: { code, source, resolverId, pluginId, stage: "read", message },
      },
      isError: true,
    },
  };
}
