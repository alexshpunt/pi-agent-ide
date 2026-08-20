import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temporaryRoot = path.resolve(".tmp/pi-agent-text-editor");

export interface GeneratedContentPromptExtensions {
  readonly paths: readonly string[];
  dispose(): Promise<void>;
}

export async function generateContentPromptExtensions(): Promise<GeneratedContentPromptExtensions> {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(path.join(temporaryRoot, "content-prompt-"));
  const extensionSources = [
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-image/index.ts",
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
    "src/extensions/pi-agent-text-editor/index.ts",
  ];
  const paths = await Promise.all(
    extensionSources.map(async (source, index) => {
      const extension = path.join(directory, `extension-${index + 1}.ts`);
      await writeFile(extension, reexportSource(source), "utf8");
      return extension;
    }),
  );
  const toolPlugin = path.join(directory, "write-tool-plugin.ts");
  await writeFile(toolPlugin, toolPluginSource(), "utf8");
  paths.push(toolPlugin);

  return {
    paths,
    async dispose(): Promise<void> {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function reexportSource(source: string): string {
  return `export { default } from ${JSON.stringify(pathToFileURL(path.resolve(source)).href)};\n`;
}

function toolPluginSource(): string {
  const packageRoot = path.resolve("src/extensions/pi-agent-text-editor");
  const connectPlugin = pathToFileURL(path.join(packageRoot, "src/api/connect-plugin.ts")).href;
  const pluginProtocol = pathToFileURL(path.join(packageRoot, "src/api/plugin-protocol.ts")).href;

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
    id: "write-pipeline",
    setup(api) {
        api.tool("write").describe("Adds fixture write behavior.");
    },
} satisfies TextEditorPlugin;

export default async function registerWriteTool(pi: ExtensionAPI): Promise<void> {
    await connectTextEditorPlugin(pi, plugin);
}
`;
}
