import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(
  "agent/src/extensions/pi-agent-ide/extensions/pi-agent-text-editor",
);
const temporaryRoot = path.resolve(".tmp/pi-agent-text-editor");

export const ASYNC_CORE_FIRST_DESCRIPTION = "Loaded after asynchronous core-first setup.";

export const ASYNC_PLUGIN_FIRST_DESCRIPTION = "Loaded after asynchronous plugin-first setup.";

export const SYNC_DESCRIPTION = "Loaded during synchronous setup.";

export interface GeneratedPluginRegistrationExtensions {
  readonly paths: readonly string[];
  dispose(): Promise<void>;
}

export async function generatePluginRegistrationExtensions(): Promise<GeneratedPluginRegistrationExtensions> {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(path.join(temporaryRoot, "plugin-registration-"));
  const coreExtension = path.join(directory, "core-extension.ts");
  const asynchronousCoreFirstPlugin = path.join(
    directory,
    "asynchronous-core-first-plugin-extension.ts",
  );
  const asynchronousPluginFirstPlugin = path.join(
    directory,
    "asynchronous-plugin-first-plugin-extension.ts",
  );
  const synchronousPlugin = path.join(directory, "synchronous-plugin-extension.ts");

  await Promise.all([
    writeFile(coreExtension, reexportSource("src/core/extension.ts"), "utf8"),
    writeFile(
      asynchronousCoreFirstPlugin,
      pluginSource("asynchronous-core-first", ASYNC_CORE_FIRST_DESCRIPTION, true),
      "utf8",
    ),
    writeFile(
      asynchronousPluginFirstPlugin,
      pluginSource("asynchronous-plugin-first", ASYNC_PLUGIN_FIRST_DESCRIPTION, true),
      "utf8",
    ),
    writeFile(
      synchronousPlugin,
      pluginSource("synchronous-plugin", SYNC_DESCRIPTION, false),
      "utf8",
    ),
  ]);

  return {
    paths: [
      asynchronousPluginFirstPlugin,
      coreExtension,
      asynchronousCoreFirstPlugin,
      synchronousPlugin,
    ],
    async dispose(): Promise<void> {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function pluginSource(pluginId: string, description: string, asynchronous: boolean): string {
  const setup = asynchronous
    ? `async setup(api) {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 25);
        });
        const tool = api.tool("write");
        tool.addHandler({ stage: "text-pre-edit", handler: (state) => state });
        tool.describe(${JSON.stringify(description)});
    }`
    : `setup(api) {
        const tool = api.tool("write");
        tool.addHandler({ stage: "text-pre-edit", handler: (state) => state });
        tool.describe(${JSON.stringify(description)});
    }`;
  const connectPlugin = packageModuleUrl("src/api/connect-plugin.ts");
  const pluginProtocol = packageModuleUrl("src/api/plugin-protocol.ts");

  return `import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPlugin } from ${JSON.stringify(connectPlugin)};
import {
    TEXT_EDITOR_API_VERSION,
    TEXT_EDITOR_PROTOCOL,
    type TextEditorPlugin,
} from ${JSON.stringify(pluginProtocol)};

const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: ${JSON.stringify(pluginId)},
    ${setup},
} satisfies TextEditorPlugin;

export default async function registerPlugin(pi: ExtensionAPI): Promise<void> {
    await connectTextEditorPlugin(pi, plugin);
}
`;
}

function reexportSource(relativePath: string): string {
  return `export { default } from ${JSON.stringify(packageModuleUrl(relativePath))};\n`;
}

function packageModuleUrl(relativePath: string): string {
  return pathToFileURL(path.join(packageRoot, relativePath)).href;
}
