import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { createStandaloneResourceHost } from "pi-agent-ide/api/standalone";
import {
  connectReadPlugin,
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-ide/api/read";
import {
  connectSearchPlugin,
  SEARCH_API_VERSION,
  SEARCH_PROTOCOL,
  type SearchPlugin,
} from "pi-agent-ide/api/search";
import type { ResourceResolver } from "pi-agent-ide/api/resource";
import { projects, editors, discoverAll, listTools, callTool } from "./backend.ts";
import { parseCatalogAddress, readCatalogTool, type UnityTool } from "./catalog.ts";
import { createUnitySearch } from "./search.ts";
import { sshTarget } from "./remote.ts";
import { inspectInstallation, installCli } from "./install.ts";

const namespace = {
  name: "unity",
  description: "Discover and operate on explicitly selected Unity projects.",
};
const project = Type.String({
  minLength: 1,
  description:
    "Absolute local project path or ssh://target/absolute/project path returned by Unity discovery.",
});
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  details: undefined,
});
const catalog = async (projectPath: string, signal?: AbortSignal) =>
  (await listTools(projectPath, signal)) as UnityTool[];

async function readUnity(source: string, signal?: AbortSignal): Promise<string> {
  if (source === "unity://projects")
    return JSON.stringify(await discoverAll("projects", signal), null, 2);
  if (source === "unity://editors")
    return JSON.stringify(await discoverAll("editors", signal), null, 2);
  const remoteDiscovery = /^unity:\/\/(projects|editors)\/([a-z0-9][a-z0-9_-]*)$/.exec(source);
  if (remoteDiscovery)
    return JSON.stringify(
      await (remoteDiscovery[1] === "projects"
        ? projects(signal, remoteDiscovery[2])
        : editors(signal, remoteDiscovery[2])),
      null,
      2,
    );
  const address = parseCatalogAddress(source);
  if (!address)
    throw new Error("Unknown Unity resource. Read unity://projects or unity://editors.");
  const tools = await catalog(address.project, signal);
  return JSON.stringify(address.name ? readCatalogTool(tools, address.name) : tools, null, 2);
}

const resolver: ResourceResolver = {
  id: "unity",
  async tryResolve(source) {
    if (!source.startsWith("unity:")) return { kind: "not-handled" };
    try {
      if (
        source !== "unity://projects" &&
        source !== "unity://editors" &&
        !/^unity:\/\/(projects|editors)\/[a-z0-9][a-z0-9_-]*$/.test(source) &&
        !parseCatalogAddress(source)
      ) {
        throw new Error("Unknown Unity resource. Read unity://projects or unity://editors.");
      }
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) };
    }
    return {
      kind: "resolved",
      resource: {
        source,
        async read({ signal }) {
          return [{ type: "text", text: await readUnity(source, signal) }];
        },
      },
    };
  },
};

export default async function unityExtension(pi: ExtensionAPI): Promise<void> {
  let guidelineRegistered = false;
  pi.on("session_start", () => {
    if (guidelineRegistered) return;
    guidelineRegistered = true;
    // Register after other extensions' startup so existing structured rule overrides compose.
    pi.on("before_agent_start", (event) => {
      const guideline =
        "For Unity work, read unity://editors (or unity://editors/<ssh-target-id> for a configured SSH target), search unity://project/<encoded-project-path>/tools for an operation, and read its returned tool URI for the schema. Preserve the ssh:// project path for remote operations. Discover unity_call with tool_search and specify the project. Without shared Read/Search, discover unity_read and unity_search.";
      const options = event.systemPromptOptions;
      if (options.customPrompt) options.sections.unity = guideline;
      else {
        options.promptGuidelines.push(guideline);
        if (options.sections.rules && !options.sections.rules.includes(guideline))
          options.sections.rules += `\n- ${guideline}`;
      }
    });
  });

  const registered = new Set<string>();
  function registerNative(tool: UnityTool): void {
    if (
      !/^[a-z][a-z0-9_]*$/.test(tool.name) ||
      ["call", "read", "search"].includes(tool.name) ||
      registered.has(tool.name) ||
      JSON.stringify(tool.inputSchema).includes('"$ref"')
    )
      return;
    registered.add(tool.name);
    pi.registerTool({
      name: `unity_${tool.name}`,
      label: tool.title || tool.name,
      namespace,
      exposure: "deferred",
      description: `${tool.description || tool.name} Always specify the exact project path.`,
      parameters: Type.Object({
        project,
        arguments: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      }),
      async execute(_id, params, signal) {
        const response = (await callTool(params.project, tool.name, params.arguments, signal)) as {
          isError?: boolean;
        };
        if (response.isError) throw new Error(JSON.stringify(response));
        return result(response);
      },
    });
  }
  const readPlugin: ReadPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "unity",
    setup(api) {
      api.addResolver({ resolver, priority: -100 });
      api.describe({
        path: "Read unity://projects, unity://editors, and Unity tool resources returned by Search.",
      });
    },
  };
  const searchPlugin: SearchPlugin = {
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "unity",
    setup(api) {
      api.addResolver({
        resolver: createUnitySearch(readUnity, catalog, registerNative),
        priority: -100,
      });
      api.describe("Search Unity resource text or the tool catalog of an explicit project.");
    },
  };
  await Promise.all([connectReadPlugin(pi, readPlugin), connectSearchPlugin(pi, searchPlugin)]);
  const host = await createStandaloneResourceHost(pi, {
    namespace,
    ownsSource: (value: string) => value.startsWith("unity:"),
    tools: ["read", "search"],
  });
  await Promise.all([
    connectReadPlugin(host.api, readPlugin),
    connectSearchPlugin(host.api, searchPlugin),
  ]);
  pi.registerTool({
    name: "unity_install_cli",
    label: "Unity CLI Setup",
    namespace,
    exposure: "deferred",
    description:
      "Use unity_install_cli to inspect the Unity CLI on a selected machine. A missing CLI is installed automatically on the first Unity request where supported; use this tool to see why it was not.",
    parameters: Type.Object({
      sshTarget: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Configured SSH target ID; omit to select the local machine.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("Unity CLI setup")) +
          theme.fg("muted", ` · ${args.sshTarget || "local"}`),
        0,
        0,
      );
    },
    renderResult(value, _options, theme, context) {
      const details = value.details as
        | { state?: string; executable?: string; detail?: string; installed?: boolean }
        | undefined;
      if (context.isError || !details) {
        const message = value.content.find((item) => item.type === "text");
        return new Text(
          theme.fg("error", message?.type === "text" ? message.text : "Unity CLI check failed."),
          0,
          0,
        );
      }
      if (details.state === "found")
        return new Text(
          theme.fg(
            "success",
            `Unity CLI ${details.installed ? "installed" : "available"}: ${details.executable}`,
          ),
          0,
          0,
        );
      if (details.state === "invalid")
        return new Text(
          theme.fg(
            "warning",
            `Unity CLI is unavailable: ${details.executable}. Check the executable.`,
          ),
          0,
          0,
        );
      return new Text(
        theme.fg("warning", details.detail || "Unity CLI setup is not supported on this machine."),
        0,
        0,
      );
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const target = params.sshTarget ? await sshTarget(params.sshTarget) : undefined;
      const machine = target ? `${target.id} (${target.host})` : "local machine";
      const inspection = await inspectInstallation(target, signal);
      const outcome = (value: typeof inspection, installed = false) => {
        const details = { target: target?.id ?? "local", ...value, installed };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      };
      if (inspection.state !== "missing") return outcome(inspection);
      if (!ctx.hasUI)
        return outcome({
          ...inspection,
          detail: "Interactive confirmation is required to install Unity CLI.",
        });
      const confirmed = await ctx.ui.confirm(
        "Install Unity CLI?",
        `Install the Unity CLI on ${machine}${inspection.destination ? ` at ${inspection.destination}` : ""}?\n\nDownloads and runs Unity's official installer from https://unity.com. Linux and macOS use a temporary isolated home and an executable in the extension's own folder; Windows, and WSL for Windows Editors, install to %LOCALAPPDATA%\\Unity\\bin and add it to the user PATH. Existing CLI files are not replaced.`,
        { signal },
      );
      signal?.throwIfAborted();
      if (!confirmed) return outcome({ ...inspection, detail: "Installation was not approved." });
      const installed = await installCli({ confirmed: true, target, signal });
      return outcome(installed, true);
    },
  });
  pi.registerTool({
    name: "unity_call",
    label: "Unity Call",
    namespace,
    exposure: "deferred",
    description:
      "Use unity_call to run a Unity MCP tool for an explicitly selected project. Search the project tool catalog and read the selected tool schema first.",
    parameters: Type.Object({
      project,
      name: Type.String({ description: "Exact Unity MCP tool name." }),
      arguments: Type.Record(Type.String(), Type.Unknown(), {
        description: "Arguments accepted by the Unity MCP tool.",
      }),
    }),
    async execute(_id, params, signal) {
      const response = (await callTool(params.project, params.name, params.arguments, signal)) as {
        isError?: boolean;
      };
      if (response.isError) throw new Error(JSON.stringify(response));
      return result(response);
    },
  });
}
