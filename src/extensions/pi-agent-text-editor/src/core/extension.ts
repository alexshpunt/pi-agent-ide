import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPluginApi,
} from "pi-agent-read/api/plugin-protocol";

import {
  clearLastResolvedResource,
  getLastResolvedResource,
  rememberLastResolvedResource,
} from "#src/api/last-resolved-resource.js";
import {
  isTextEditorPluginRegistrationRequest,
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_CORE_READY_EVENT,
  TEXT_EDITOR_PLUGIN_REGISTER_EVENT,
  TEXT_EDITOR_PROTOCOL,
} from "#src/api/plugin-protocol.js";
import {
  isTextPostEditHandlerRegistrationRequest,
  TEXT_EDITOR_POST_EDIT_REGISTER_EVENT,
} from "#src/api/post-edit.js";
import { setTextAnchorRecoveryReader } from "#src/core/text-anchor-recovery.js";
import { setTextEditBatchRenderArgumentSink } from "#src/core/text-edit-batch-registrar.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { createReadFragmentResolver } from "#src/core/read-fragment-resolver.js";
import { createTextTool } from "#src/core/text-mutation.js";
import { ToolCallInterceptionRenderStore } from "#src/core/tool-call-interceptor/rendering.js";
import { registerToolCallAnnotationSink } from "pi-agent-text-editor/api/tool-call-interceptor";

export default async function registerTextEditorCore(
  pi: ExtensionAPI,
): Promise<ReturnType<typeof createTextEditorCore>> {
  const interceptionRendering = new ToolCallInterceptionRenderStore();
  const connectInterceptionRendering = () => {
    clearLastResolvedResource(pi);
    registerToolCallAnnotationSink(pi, interceptionRendering.annotate);
  };
  connectInterceptionRendering();
  pi.on("session_start", connectInterceptionRendering);
  pi.on("session_shutdown", () => {
    clearLastResolvedResource(pi);
    registerToolCallAnnotationSink(pi);
    interceptionRendering.clear();
  });
  const mutationTools = new Set<string>();
  const core = createTextEditorCore((registration, editor) => {
    mutationTools.add(registration.name);
    pi.registerTool(
      createTextTool(
        editor,
        registration,
        interceptionRendering,
        () =>
          [
            editor.renderGeneralPromptGuideline(),
            editor.renderToolPromptGuideline(registration.name),
          ]
            .filter((guideline): guideline is string => guideline !== undefined)
            .join("\n\n") || undefined,
        () => getLastResolvedResource(pi)?.source,
      ),
    );
  });
  setTextEditBatchRenderArgumentSink(core, interceptionRendering.resolveArguments);
  pi.on("tool_result", (event) => {
    rememberLastResolvedResource(pi, event.details);

    if (mutationTools.has(event.toolName) && isFailedTextMutationResult(event.details)) {
      return { isError: true };
    }

    return;
  });
  let readApi: ReadPluginApi | undefined;
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "text-anchor-recovery",
    setup(api): void {
      readApi = api;
      api.addTargetResolver({ resolver: core.textTargetResolver() });
      api.addFragmentResolver(createReadFragmentResolver(core));

      api.addPromptGuideline(
        "You can use read with `<path>#<anchor>`, `offset`, and `limit` to inspect context around a known anchor without rereading the whole file.",
      );
      api.addPromptGuideline(
        "For an anchored read, omitted `offset`, `offset: 0`, and `offset: 1` all start at the anchor line; positive offsets greater than one count forward, while negative offsets count upward.",
      );
      api.addPromptGuideline(
        "After search finds a relevant result, you can use read with the returned `SEARCH#...` source, `offset`, and `limit` to inspect only the surrounding context you need.",
      );
    },
  });
  setTextAnchorRecoveryReader(core, (request, context) => {
    if (readApi === undefined) {
      throw new Error("Text anchor recovery requires pi-agent-read");
    }

    // Recovery context teaches the agent a fresh anchor, so it must carry hashes.
    return readApi.read({ ...request, views: ["anchors"] }, context);
  });

  const unsubscribeRegistration = pi.events.on(TEXT_EDITOR_PLUGIN_REGISTER_EVENT, (request) => {
    if (!isTextEditorPluginRegistrationRequest(request)) {
      throw new Error("Invalid pi-agent-text-editor plugin registration request");
    }

    request.accept(core.registerPlugin(request.plugin));
  });
  pi.on("session_shutdown", unsubscribeRegistration);
  const unsubscribePostEdit = pi.events.on(TEXT_EDITOR_POST_EDIT_REGISTER_EVENT, (request) => {
    if (!isTextPostEditHandlerRegistrationRequest(request)) {
      throw new Error("Invalid pi-agent-text-editor post-edit handler registration request");
    }

    request.accept(core.registerPostEditHandler(request.registration));
  });
  pi.on("session_shutdown", unsubscribePostEdit);
  pi.events.emit(TEXT_EDITOR_CORE_READY_EVENT, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
  });

  await core.waitForPendingPlugins();
  return core;
}

function isFailedTextMutationResult(details: unknown): boolean {
  if (!isRecord(details)) {
    return false;
  }

  const recovery = details.batchRecovery;

  if (isRecord(recovery) && typeof recovery.state === "string" && recovery.state !== "completed") {
    return true;
  }

  const results = details.results;
  return (
    Array.isArray(results) &&
    results.some((result) => {
      if (!isRecord(result)) {
        return false;
      }

      const data = isRecord(result.data) ? result.data : result;
      return data.ok === false;
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
