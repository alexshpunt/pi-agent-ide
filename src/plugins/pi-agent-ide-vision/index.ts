import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";
import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { visionDoctorPlugin } from "./src/doctor-plugin.js";

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
  isNativeExecutableAllowed,
  listProcesses,
  parseDisplaySource,
  parseVisionView,
  readProcess,
  type VisionOptions,
  type ProcessMetadata,
  type RemoteProcessMetadata,
  withRemoteProcessOwnership,
} from "#src/plugins/pi-agent-ide-vision/src/vision.js";

/** Target-native capture. Registration checks opt-in and current target ownership before each frame. */
export interface CaptureOwnerAccess {
  /** Capture an explicitly owned web resource; never select a local browser for it. */
  captureWeb?(source: string, signal?: AbortSignal): Promise<Uint8Array>;
  captureWindow(
    source: string,
    process: RemoteProcessMetadata,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  captureDisplay(source: string, index: number, signal?: AbortSignal): Promise<Uint8Array>;
}
/** Optional resource-owner metadata. Undefined means unclaimed, never a remote-to-local fallback. */
export interface ProcessOwnerAccess {
  read(source: string, signal?: AbortSignal): Promise<RemoteProcessMetadata | undefined>;
  list(scope: string, signal?: AbortSignal): Promise<readonly RemoteProcessMetadata[] | undefined>;
}
/** Register process discovery and guarded visual capture resources. */
export default async function registerVision(
  pi: ExtensionAPI,
  context?: BuiltinExtensionContext,
): Promise<void> {
  await registerVisionWithOwner(pi, context);
}

/** Register existing process and capture interfaces with optional target-owned metadata. */
export async function registerVisionWithOwner(
  pi: ExtensionAPI,
  context?: BuiltinExtensionContext,
  processOwner?: ProcessOwnerAccess,
  captureOwner?: CaptureOwnerAccess,
): Promise<void> {
  connectAgentDocumentation(pi, [
    await loadPackagedAgentGuide({
      id: "vision",
      description: "Window, display, image, and sequence capture",
      triggers: [
        { tool: "read", resourcePrefixes: ["process:", "window:", "display:"] },
        { tool: "read", resourcePrefixes: ["web:ssh://"], viewPrefixes: ["image", "sequence"] },
      ],
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
    connectDoctorPlugin(pi, visionDoctorPlugin),
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
            if (source.startsWith("window:ssh://") || source.startsWith("display:ssh://")) {
              try {
                const window = source.startsWith("window:");
                const uri = new URL(source.slice(window ? "window:".length : "display:".length));
                if (
                  uri.username ||
                  uri.password ||
                  uri.port ||
                  uri.search ||
                  (window
                    ? uri.hash !== "" || !/^\/[1-9][0-9]*$/u.test(uri.pathname)
                    : uri.pathname !== "/" || (uri.hash !== "" && !/^#\d+$/u.test(uri.hash)))
                )
                  throw new Error(`Invalid target capture resource: ${source}`);
                if (!window && pi.getFlag("pi-agent-ide-vision-displays") !== true)
                  return failed(
                    source,
                    "Display capture is disabled. Enable --pi-agent-ide-vision-displays to allow it.",
                  );
                if (!captureOwner)
                  return failed(source, `Target capture is unavailable: ${source}`);
                const index = window
                  ? Number(uri.pathname.slice(1))
                  : Number(uri.hash.slice(1) || "0");
                if (!Number.isSafeInteger(index))
                  throw new Error(`Invalid target capture resource: ${source}`);
                const content = await captureImages(
                  async () => {
                    if (!window)
                      return captureOwner.captureDisplay(
                        source,
                        index,
                        context.resolverContext.signal,
                      );
                    const processSource = `process:ssh://${uri.hostname}/${index}`;
                    const snapshot = await processOwner?.read(
                      processSource,
                      context.resolverContext.signal,
                    );
                    if (
                      !snapshot ||
                      snapshot.resource !== processSource ||
                      snapshot.pid !== index ||
                      snapshot.target !== uri.hostname
                    )
                      throw new Error(`Target process identity is unavailable: ${source}`);
                    const metadata = withRemoteProcessOwnership(snapshot, registry);
                    const executable = metadata.executable;
                    // Use the native executable, not a command-line prefix or controller PID.
                    if (
                      !metadata.owned &&
                      (!executable || !isNativeExecutableAllowed(executable)) &&
                      pi.getFlag("pi-agent-ide-vision-arbitrary-windows") !== true
                    )
                      throw new Error(
                        `Window capture is denied for the target executable: ${source}`,
                      );
                    return captureOwner.captureWindow(
                      source,
                      metadata,
                      context.resolverContext.signal,
                    );
                  },
                  options(context.request),
                  context.resolverContext.signal,
                );
                return returned(source, content);
              } catch (error) {
                return failed(source, errorMessage(error));
              }
            }
            if (source.startsWith("web:") && requestsScreenshot(context.request)) {
              try {
                const captureWeb = captureOwner?.captureWeb?.bind(captureOwner);
                if (!captureWeb)
                  return failed(source, `Target web capture is unavailable: ${source}`);
                const content = await captureImages(
                  () => captureWeb(source, context.resolverContext.signal),
                  options(context.request),
                  context.resolverContext.signal,
                );
                return returned(source, content);
              } catch (error) {
                return failed(source, errorMessage(error));
              }
            }
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
            try {
              const owned = await processOwner?.read(source, context.resolverContext.signal);
              if (owned)
                return returned(source, [
                  {
                    type: "text",
                    text: formatProcess(withRemoteProcessOwnership(owned, registry)),
                  },
                ]);
            } catch (error) {
              return failed(source, errorMessage(error));
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
                  () =>
                    backend.captureWindow(windowPid, metadata.host, context.resolverContext.signal),
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
          `Process metadata: process:PID locally or process:ssh://target/PID on a configured Linux target. Remote metadata includes kernel start identity and does not grant local capture or control. Visual capture: window:PID and display: or display:#N locally; window:ssh://target/PID and display:ssh://target/ or display:ssh://target/#N on configured X11 targets. Remote frames retain their requested source; window capture rechecks target start identity, executable authorization and X-Resource 1.2 server-observed native client ownership. Display opt-in still applies. Missing target facilities fail without controller capture. Target acquisition is limited to 16 million pixels per frame. HTTP(S) sources accept image and sequence screenshots locally; web:ssh://target/https://… uses target-installed Playwright and Chrome/Chromium for those views, without controller fallback. Use named view parameters such as sequence:duration=2,interval=0.5,scale=0.5 and image:scale=0.5,region=0.25,0.25,0.5,0.5. Duration is limited to 10 seconds and sequences to 20 frames. Defaults: duration=${defaults.durationSeconds}, interval=${defaults.intervalSeconds}, scale=${defaults.scale}. Region uses normalized x,y,width,height and runs before scaling. For captures, limit is a square grid cell size in output pixels and offset is one zero-based row-major cell index; limit without offset selects cell 0, while offset without limit is invalid. Omit both for the bounded transformed image.`,
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
            toScriptData(payload) {
              const processes = payload as readonly (ProcessMetadata | RemoteProcessMetadata)[];
              return {
                kind: "custom",
                resolverId: "processes",
                value: {
                  processes: processes.map((item) => ({
                    pid: item.pid,
                    command: item.command,
                    ...(item.host === "ssh"
                      ? {
                          host: item.host,
                          target: item.target,
                          resource: item.resource,
                          identity: item.identity,
                          owned: item.owned,
                          parentPid: item.parentPid,
                          started: item.started,
                          executable: item.executable,
                          ...(item.source === undefined ? {} : { source: item.source }),
                        }
                      : {}),
                  })),
                },
              };
            },
            async tryResolve(request, context) {
              const match = /^process:(.*)$/isu.exec(request.query);
              if (match === null) return { kind: "not-handled" as const };
              const query = (match[1] ?? "").trim().toLowerCase();
              const scope = request.path ?? context.cwd;
              const remote = await processOwner?.list(scope, context.signal);
              if (scope.includes("://") && remote === undefined)
                throw new Error("Process scope has no resource owner");
              const matches = (
                remote?.map((item) => withRemoteProcessOwnership(item, registry)) ??
                (await listProcesses(registry))
              )
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
              const processes = payload as readonly (ProcessMetadata | RemoteProcessMetadata)[];
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
          "process:<query> finds running processes by PID or command. Select a configured Linux target with an SSH path; its results retain process:ssh://target/PID, target and kernel start identity. Use process:PID for local metadata. Use window:ssh://target/PID for authorized target capture, never window:PID with a remote PID. Discovery alone does not grant capture or process control.",
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
    result: {
      content,
      script: { kind: "native" as const, source, blocks: content },
      details: { source, resolvedBy: "vision" },
    },
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
function formatProcess(item: ProcessMetadata | RemoteProcessMetadata): string {
  return [
    `PID: ${item.pid}`,
    ...(item.host === "ssh"
      ? [`Target: ${item.target}`, `Resource: ${item.resource}`, `Identity: ${item.identity}`]
      : []),
    `Command: ${item.command}`,
    `Owned by Agent IDE: ${item.owned ? "yes" : "no"}`,
    ...(item.host === "ssh" && item.executable !== null ? [`Executable: ${item.executable}`] : []),
    ...(item.parentPid === undefined ? [] : [`Parent PID: ${item.parentPid}`]),
    ...(item.started === undefined ? [] : [`Started: ${item.started}`]),
    ...(item.source === undefined ? [] : [`Agent IDE source: ${item.source}`]),
  ].join("\n");
}
