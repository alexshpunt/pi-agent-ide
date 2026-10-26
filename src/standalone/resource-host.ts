import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { connectResultTargets } from "pi-agent-resource";
import { registerOperationApproval } from "pi-agent-tool-ui/operation-approval";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPluginApi,
} from "pi-agent-read/api/plugin-protocol";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";
import { createIdeTextResults } from "#src/composite/text-results.js";
import registerReadCore from "#src/extensions/pi-agent-read/src/core/extension.js";
import { createReadResultTargetHandler } from "#src/extensions/pi-agent-read/src/core/tools/read/result-target.js";
import registerSearchCore from "#src/extensions/pi-agent-search/src/core/extension.js";
import { registerResourceSearchSelections } from "#src/extensions/pi-agent-search/plugins/pi-agent-search-text/index.js";
import registerEditorCore from "#src/extensions/pi-agent-text-editor/src/core/extension.js";
import { registerTextEditorTools } from "#src/extensions/pi-agent-text-editor/src/tools/extension.js";
import registerConstantAnchors from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-constant/index.js";
import registerHashAnchors from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.js";
import registerExactAnchors from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-exact/index.js";
import registerRenderer from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/index.js";
import registerDocumentation from "#src/documentation/extension.js";
import { createResourceHostApi } from "./scoped-api.js";

export type StandaloneResourceTool =
  | "read"
  | "search"
  | "write"
  | "replace"
  | "insert"
  | "delete"
  | "copy"
  | "move"
  | "diff";
export interface StandaloneResourceHostOptions {
  /** A stable identifier; tool names become <namespace>_<verb>. */
  readonly namespace: NonNullable<ToolDefinition["namespace"]>;
  /** Explicit provider resource ownership, not an OS sandbox. Local paths and file: are refused. */
  readonly ownsSource: (source: string) => boolean;
  /** Expose only this subset. The underlying kernels remain available to provider protocols. */
  readonly tools?: readonly StandaloneResourceTool[];
}
export interface StandaloneResourceHost {
  /** Connect existing Read, Search, editor and documentation plugins to this isolated bus. */
  readonly api: ExtensionAPI;
  readonly tools: readonly string[];
  /** Retire this host and its references without shutting down the session or sibling hosts. */
  dispose(context: ExtensionContext): Promise<void>;
}

/**
 * Register deferred resource tools on shared IDE kernels. Call during extension registration,
 * then connect the provider to host.api. No filesystem, process, web or Git backends are installed.
 * Approval uses the real session's single service; an existing policy is never replaced here.
 */
export async function createStandaloneResourceHost(
  pi: ExtensionAPI,
  options: StandaloneResourceHostOptions,
): Promise<StandaloneResourceHost> {
  registerOperationApproval(pi);
  const scope = createResourceHostApi(pi, options);
  const results = createIdeTextResults(scope.api, {
    resourceOutput: true,
    promptSection: `resource_${options.namespace.name}_results`,
  });
  const api = results.api;
  scope.setApi(api);
  try {
    await registerReadCore(api);
    let read: ReadPluginApi | undefined;
    await connectReadPlugin(api, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: "standalone-resource-boundary",
      setup(value) {
        read = value;
        scope.setRead(value);
        value.addResourceGuard({
          id: "standalone-resource-boundary",
          guard: (event) =>
            scope.owns(event.resourceSource, false)
              ? { kind: "accepted" }
              : { kind: "rejected", reason: "Resource belongs outside this standalone host." },
        });
        value.addHandler({
          stage: "post-read",
          handler: createReadResultTargetHandler(connectResultTargets(api), value.read, (source) =>
            scope.owns(source, true),
          ),
        });
      },
    });
    await registerSearchCore(api);
    const editor = await registerEditorCore(api);
    await editor.registerPlugin({
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "standalone-resource-boundary",
      setup(value) {
        value.addMutationGuard({
          id: "standalone-resource-boundary",
          guard: (plan) =>
            plan.resources.every(
              (resource) => scope.owns(resource.source, true) && resource.binary === undefined,
            )
              ? { kind: "accepted" }
              : {
                  kind: "rejected",
                  rejection: {
                    code: "RESOURCE_HOST_BOUNDARY",
                    reason: "Resource belongs outside this standalone host.",
                    message: "Use this host only for its provider-owned text resources.",
                    effect: "not-applied",
                  },
                },
        });
      },
    });
    await registerConstantAnchors(api);
    await registerHashAnchors(api);
    await registerExactAnchors(api);
    await registerResourceSearchSelections(api);
    if (!read) throw new Error("Standalone Read host did not initialize.");
    await registerDocumentation(api, {
      recordType: `agent-documentation-read/${options.namespace.name}`,
      ownsTool: (name) => typeof name === "string" && scope.tools.includes(name),
    });
    await registerRenderer(api, {
      preferences: {},
      toolName: (name) => `${options.namespace.name}_${name}`,
    });
    // Mutation definitions capture their initial renderer during registration.
    registerTextEditorTools(api, editor);
    results.finalize();
    return { api, tools: scope.tools, dispose: (context) => scope.dispose(context) };
  } catch (error) {
    await scope.dispose();
    throw error;
  }
}
