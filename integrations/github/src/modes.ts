import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL } from "pi-agent-ide/api/read";
import { connectSearchPlugin, SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-ide/api/search";
import {
  connectTextEditorPlugin,
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-ide/api/text-editor";

/** Claim GitHub resources, never local paths, other providers or credential-bearing URLs. */
function ownsGithubSource(source: string): boolean {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return false;
  }
  if (url.username || url.password || url.port) return false;
  return (
    (url.protocol === "github:" && !!url.hostname) ||
    (url.protocol === "https:" && ["github.com", "api.github.com"].includes(url.hostname))
  );
}

/** Choose a surface after every extension factory has had a chance to accept the public protocols. */
export async function connectGithubMode(
  pi: ExtensionAPI,
  connect: (api: ExtensionAPI, mode: "ide" | "standalone") => Promise<void>,
): Promise<void> {
  const accepted = new Set<string>();
  // Empty probes do not attach a backend or contribute tools to a partial IDE.
  const optional = (registration: void | Promise<void>) =>
    Promise.resolve(registration).catch(() => undefined);
  await Promise.all([
    optional(
      connectReadPlugin(pi, {
        protocol: READ_PROTOCOL,
        apiVersion: READ_API_VERSION,
        id: "github-mode",
        setup() {
          accepted.add("read");
        },
      }),
    ),
    optional(
      connectSearchPlugin(pi, {
        protocol: SEARCH_PROTOCOL,
        apiVersion: SEARCH_API_VERSION,
        id: "github-mode",
        setup() {
          accepted.add("search");
        },
      }),
    ),
    optional(
      connectTextEditorPlugin(pi, {
        protocol: TEXT_EDITOR_PROTOCOL,
        apiVersion: TEXT_EDITOR_API_VERSION,
        id: "github-mode",
        setup() {
          accepted.add("editor");
        },
      }),
    ),
  ]);
  if (accepted.size === 3) {
    await connect(pi, "ide");
    return;
  }
  // The host must see initial lifecycle events. Creating it inside session_start is too late.
  const { createStandaloneResourceHost } = await import("pi-agent-ide/api/standalone").catch(
    (error) => {
      throw new Error(
        "Standalone GitHub tools require a pi-agent-ide package exporting api/standalone.",
        { cause: error },
      );
    },
  );
  const host = await createStandaloneResourceHost(pi, {
    namespace: {
      name: "github",
      description: "Read, search and change GitHub resources through the session's GitHub App.",
    },
    ownsSource: ownsGithubSource,
  });
  await connect(host.api, "standalone");
  host.api.on("before_agent_start", (event) => ({
    systemPrompt:
      event.systemPrompt +
      '\nFor GitHub resources, use the github_* tools. Resource-tool names in GitHub guides mean their github_ counterparts (Read means github_read). Start with github_read({path: "docs:github"}). Keep ordinary local-file tools separate. Standalone GitHub always runs YOLO: typed actions and raw API writes do not ask for confirmation, and IDE YOLO settings do not apply. Keep App permissions, stale-target checks and unknown-effect handling intact; never replay an unknown mutation.',
  }));
  let chosen = false;
  pi.on("session_start", async (_event, context) => {
    if (chosen) return;
    chosen = true;
    if (accepted.size !== 3) return;
    // Pi cannot unregister tools; disposal hides them and retires their private references/hooks.
    await host.dispose(context);
    await connect(pi, "ide");
  });
}
