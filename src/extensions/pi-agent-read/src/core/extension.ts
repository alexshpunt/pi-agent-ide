import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  attachFileTextWindows,
  type FileTextWindow,
  connectResultTargets,
  trackScriptCalls,
  fileTextDigest,
  fileTextKeys,
  FILE_TEXT_READ_EVENT,
  type FileTextRead,
} from "pi-agent-resource";
import {
  createReadResultTargetHandler,
  intersectRange,
} from "#src/core/tools/read/result-target.ts";
import { lastShownReadLine } from "#src/core/tools/read/output-truncation.ts";
import {
  ToolCallInterceptionRenderStore,
  withToolCallInterceptionRendering,
} from "pi-agent-tool-call-interception";

import {
  isReadPluginRegistrationRequest,
  READ_API_VERSION,
  READ_CORE_READY_EVENT,
  READ_PLUGIN_REGISTER_EVENT,
  READ_PROTOCOL,
} from "#src/api/plugin-protocol.ts";
import { createReadCore } from "#src/core/read-core.ts";

import { compactReadDetails } from "#src/core/tools/read/persisted-result.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePresentation(value: string | undefined): "full" | "compact" | "disabled" {
  return value === "full" || value === "disabled" ? value : "compact";
}
export default async function registerReadCore(
  pi: ExtensionAPI,
  context?: { readonly preferences: Readonly<Record<string, string>> },
): Promise<void> {
  // Codemode scripts and other tools call Read through Pi; their results skip the model budget.
  const core = createReadCore(
    () => parsePresentation(context?.preferences["ui.read"]),
    trackScriptCalls(pi, "read"),
  );
  const targets = connectResultTargets(pi);
  core.read.setReadObserver(async ({ script, details, content }, cwd, nested) => {
    if (script === undefined) return;
    const windows: FileTextWindow[] = [];
    const truncation = details.truncation?.truncated === true ? details.truncation : undefined;
    // Joined windows can contain notices between windows. Don't infer their individual cutoffs.
    const resources =
      script.kind === "resources" ? (truncation === undefined ? script.resources : []) : [script];
    for (const resource of resources) {
      if (resource.kind !== "text" || resource.fileDigest === undefined) continue;
      const { source, fileDigest: digest } = resource;
      const keys = await fileTextKeys(source, cwd);
      if (keys.length === 0) continue;

      // Use the returned snapshot, not a fresh read of the file.
      const shown =
        resource.target === undefined
          ? undefined
          : (() => {
              try {
                return targets.resolve(resource.target, cwd);
              } catch {
                return undefined;
              }
            })();
      const snapshot = shown?.targets.find(
        (target) => target.source === source && fileTextDigest(target.expectedContent) === digest,
      );
      // The script selection stays whole even when the model's text was head-truncated.
      const ranges = snapshot?.ranges ?? [];
      const first = resource.lines[0];
      const last = truncation === undefined ? undefined : lastShownReadLine(resource, truncation);
      const visibleRanges =
        truncation === undefined
          ? ranges
          : first === undefined || last === undefined
            ? []
            : ranges
                .filter((range) => range.adjusted !== true)
                .flatMap((range) =>
                  intersectRange(range, {
                    start: { lineNumber: first.lineNumber, column: 0 },
                    end: { lineNumber: last.lineNumber, column: last.content.length },
                  }),
                );
      const visibility =
        snapshot === undefined
          ? undefined
          : { content: snapshot.expectedContent, ranges: visibleRanges };
      pi.events.emit(FILE_TEXT_READ_EVENT, {
        keys,
        digest,
        ...(nested && visibility !== undefined && { visible: visibility }),
        complete: truncation === undefined && fileTextDigest(resource.content) === digest,
      } satisfies FileTextRead);
      if (!nested && visibility !== undefined) windows.push({ source, ...visibility });
    }
    // Direct multi-path reads are limited again after the individual windows are joined.
    const block = content.length === 1 ? content[0] : undefined;
    if (block?.type === "text") attachFileTextWindows(block, windows);
  });
  await core.registerPlugin({
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "result-targets",
    setup(api) {
      api.addHandler({
        stage: "post-read",
        handler: createReadResultTargetHandler(targets, core.read.execute),
      });
    },
  });

  const unsubscribeRegistration = pi.events.on(READ_PLUGIN_REGISTER_EVENT, (request) => {
    if (!isReadPluginRegistrationRequest(request)) {
      throw new Error("Invalid pi-agent-read plugin registration request");
    }

    request.accept(core.registerPlugin(request.plugin));
  });
  pi.on("session_shutdown", async () => {
    unsubscribeRegistration();
    await core.read.dispose();
  });

  const interceptionRendering = new ToolCallInterceptionRenderStore();
  const definition = withToolCallInterceptionRendering(core.read.tool, interceptionRendering);
  pi.registerTool(definition);
  pi.on("before_agent_start", async () => {
    await core.waitForPendingPlugins();
    // Pi snapshots schemas when it wraps definitions. Refresh current plugin metadata for this run.
    if (pi.getActiveTools().includes("read")) pi.registerTool(definition);
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read" || !isRecord(event.details)) {
      return;
    }

    return {
      details: compactReadDetails(
        event.details,
        event.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
      ),
      ...(event.details.failure !== undefined && { isError: true }),
    };
  });
  pi.events.emit(READ_CORE_READY_EVENT, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
  });

  await core.waitForPendingPlugins();
}
