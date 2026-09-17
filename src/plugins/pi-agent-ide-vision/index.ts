import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";

import type { BuiltinExtensionContext } from "#src/composite/selection.js";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL } from "pi-agent-read/api/plugin-protocol";
import type { ReadRequest, ReadToolResult } from "pi-agent-read/api/tools/read";
import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";

import { agentIdeProcessRegistry } from "#src/plugins/pi-agent-ide-processes/src/registry.js";
import {
  captureImages,
  configureVision,
  createCaptureBackend,
  getVisionDefaults,
  isExecutableAllowed,
  listProcesses,
  parseDisplaySource,
  parseVisionView,
  readProcess,
  type VisionOptions,
} from "#src/plugins/pi-agent-ide-vision/src/vision.js";

/** Register process discovery and guarded visual capture resources. */
export default async function registerVision(
  pi: ExtensionAPI,
  context?: BuiltinExtensionContext,
): Promise<void> {
  connectAgentDocumentation(pi, [
    await loadPackagedAgentGuide({
      id: "vision",
      description: "Window, display, image, and sequence capture",
      triggers: [{ tool: "read", resourcePrefixes: ["window:", "display:"] }],
    }),
  ]);
  const preferences = context?.preferences ?? {};
  configureVision({
    durationSeconds: preferences["vision.sequenceDurationSeconds"],
    intervalSeconds: preferences["vision.sequenceIntervalSeconds"],
    scale: preferences["vision.imageScale"],
    allowedExecutables: preferences["vision.allowedExecutables"],
  });
  const registry = agentIdeProcessRegistry(pi);
  const backend = createCaptureBackend();
  await Promise.all([
    connectReadPlugin(pi, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: "vision",
      setup(api) {
        for (const view of ["image", "sequence"]) {
          api.addView({
            view,
            presenter: { id: `vision-${view}`, present: (document) => document },
          });
        }
        api.addHandler({
          stage: "pre-read",
          async handler(context) {
            const source = context.request.path;
            if (source === undefined) return { kind: "continue", context };
            const displayIndex = parseDisplaySource(source);
            if (displayIndex !== undefined) {
              if (pi.getFlag("pi-agent-ide-vision-displays") !== true) {
                return failed(
                  source,
                  "Display capture is disabled. Enable --pi-agent-ide-vision-displays to allow it.",
                );
              }
              try {
                const content = await captureImages(
                  () => backend.captureDisplay(displayIndex, context.resolverContext.signal),
                  options(context.request),
                  context.resolverContext.signal,
                );
                return returned(source, content);
              } catch (error) {
                return failed(source, errorMessage(error));
              }
            }
            const processPid = prefixedPid(source, "process:");
            if (processPid !== undefined) {
              const metadata = await readProcess(processPid, registry);
              return returned(source, [{ type: "text", text: formatProcess(metadata) }]);
            }
            const windowPid = prefixedPid(source, "window:");
            if (windowPid !== undefined) {
              const metadata = await readProcess(windowPid, registry);
              if (
                !metadata.owned &&
                !isExecutableAllowed(metadata.command) &&
                pi.getFlag("pi-agent-ide-vision-arbitrary-windows") !== true
              ) {
                return failed(
                  source,
                  `Window capture for PID ${windowPid} is denied because the process is neither Agent IDE-owned nor allowlisted by executable name. Enable --pi-agent-ide-vision-arbitrary-windows to allow it.`,
                );
              }

              try {
                const content = await captureImages(
                  () => backend.captureWindow(windowPid, context.resolverContext.signal),
                  options(context.request),
                  context.resolverContext.signal,
                );
                return returned(source, content);
              } catch (error) {
                return failed(source, errorMessage(error));
              }
            }
            if (/^https?:\/\//iu.test(source) && requestsScreenshot(context.request)) {
              const url = new URL(source);
              try {
                const content = await captureImages(
                  () => backend.captureUrl(url, context.resolverContext.signal),
                  options(context.request),
                  context.resolverContext.signal,
                );
                return returned(url.href, content);
              } catch (error) {
                return failed(url.href, errorMessage(error));
              }
            }
            return { kind: "continue", context };
          },
        });
        const defaults = getVisionDefaults();
        api.describe(
          `Process metadata: process:PID. Visual capture: window:PID and display: or display:#N. HTTP(S) sources accept image and sequence screenshots. Use named view parameters such as sequence:duration=2,interval=0.5,scale=0.5 and image:scale=0.5,region=0.25,0.25,0.5,0.5. Duration is limited to 10 seconds and sequences to 20 frames. Defaults: duration=${defaults.durationSeconds}, interval=${defaults.intervalSeconds}, scale=${defaults.scale}. Region uses normalized x,y,width,height and runs before scaling. For captures, limit is a square grid cell size in output pixels and offset is one zero-based row-major cell index; limit without offset selects cell 0, while offset without limit is invalid. Omit both for the bounded transformed image.`,
        );
      },
    }),
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "vision-processes",
      setup(api) {
        api.addResolver({
          priority: -100,
          resolver: {
            id: "processes",
            async tryResolve(request) {
              const match = /^process:(.*)$/isu.exec(request.query);
              if (match === null) return { kind: "not-handled" as const };
              const query = (match[1] ?? "").trim().toLowerCase();
              const matches = (await listProcesses(registry))
                .filter(
                  (item) =>
                    query.length === 0 ||
                    String(item.pid) === query ||
                    item.command.toLowerCase().includes(query),
                )
                .slice(0, Math.min(request.limit ?? 50, 100));
              return { kind: "resolved" as const, payload: matches };
            },
            format(payload) {
              const processes = payload as Awaited<ReturnType<typeof listProcesses>>;
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      processes.length === 0
                        ? "No matching processes."
                        : processes.map(formatProcess).join("\n\n"),
                  },
                ],
                details: { count: processes.length, processes },
              };
            },
          },
        });
        api.describe(
          "process:<query> finds running processes by PID or command for process:PID metadata reads and guarded window:PID capture.",
        );
      },
    }),
  ]);
}

function prefixedPid(source: string, prefix: string): number | undefined {
  if (!source.startsWith(prefix)) return undefined;
  const value = source.slice(prefix.length);
  if (!/^\d+$/u.test(value)) throw new Error(`${prefix} sources require a numeric PID`);
  return Number(value);
}
function options(request: ReadRequest): VisionOptions {
  const selected = parseVisionView(request.views, getVisionDefaults()) ?? {
    mode: "image" as const,
    ...getVisionDefaults(),
  };
  return {
    ...selected,
    ...(request.limit === undefined ? {} : { cellSize: request.limit }),
    ...(request.offset === undefined ? {} : { cellIndex: request.offset }),
  };
}
function requestsScreenshot(request: ReadRequest): boolean {
  return request.views?.some((view) => /^(?:image|sequence)(?::|$)/u.test(view)) === true;
}
function returned(source: string, content: ReadToolResult["content"]) {
  return {
    kind: "return" as const,
    result: { content, details: { source, resolvedBy: "vision" } },
  };
}
function failed(source: string, message: string) {
  return {
    kind: "return" as const,
    result: {
      content: [{ type: "text" as const, text: message }],
      details: {
        source,
        resolvedBy: "vision",
        failure: { code: "READ_FAILED" as const, source, resolverId: "vision", message },
      },
      isError: true,
    },
  };
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function formatProcess(item: Awaited<ReturnType<typeof readProcess>>): string {
  return [
    `PID: ${item.pid}`,
    `Command: ${item.command}`,
    `Owned by Agent IDE: ${item.owned ? "yes" : "no"}`,
    ...(item.parentPid === undefined ? [] : [`Parent PID: ${item.parentPid}`]),
    ...(item.started === undefined ? [] : [`Started: ${item.started}`]),
    ...(item.source === undefined ? [] : [`Agent IDE source: ${item.source}`]),
  ].join("\n");
}
