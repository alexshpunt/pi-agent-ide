import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve("agent/src/extensions/pi-agent-ide/extensions/pi-agent-read");
const temporaryRoot = path.resolve(".tmp");

export const ASYNC_CORE_FIRST_SOURCE = "async-core-first";

export const ASYNC_PLUGIN_FIRST_SOURCE = "async-plugin-first";

export const ASYNC_RESOLVER_TEXT = "resolved after asynchronous setup";

export const SYNC_RESOLVER_SOURCE = "sync-registration";

export const SYNC_RESOLVER_TEXT = "resolved during synchronous setup";

export interface GeneratedPluginRegistrationExtensions {
  readonly paths: readonly string[];
  dispose(): Promise<void>;
}

export async function generatePluginRegistrationExtensions(): Promise<GeneratedPluginRegistrationExtensions> {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(path.join(temporaryRoot, "pi-agent-read-plugin-registration-"));
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
    writeFile(coreExtension, reexportSource("#src/core/extension.js"), "utf8"),
    writeFile(
      asynchronousCoreFirstPlugin,
      pluginSource(
        "asynchronous-core-first-plugin",
        ASYNC_CORE_FIRST_SOURCE,
        ASYNC_RESOLVER_TEXT,
        true,
      ),
      "utf8",
    ),
    writeFile(
      asynchronousPluginFirstPlugin,
      pluginSource(
        "asynchronous-plugin-first-plugin",
        ASYNC_PLUGIN_FIRST_SOURCE,
        ASYNC_RESOLVER_TEXT,
        true,
      ),
      "utf8",
    ),
    writeFile(
      synchronousPlugin,
      pluginSource("synchronous-plugin", SYNC_RESOLVER_SOURCE, SYNC_RESOLVER_TEXT, false),
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

function pluginSource(
  pluginId: string,
  supportedSource: string,
  resultText: string,
  asynchronous: boolean,
): string {
  const setup = asynchronous
    ? `async setup(api) {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 25);
        });
        api.addResolver({ resolver });
    }`
    : `setup(api) {
        api.addResolver({ resolver });
    }`;

  const connectPlugin = packageModuleUrl("src/api/connect-plugin.ts");
  const pluginProtocol = packageModuleUrl("src/api/plugin-protocol.ts");
  const resourceApi = pathToFileURL(
    path.resolve("agent/src/extensions/pi-agent-ide/packages/pi-agent-resource/src/index.ts"),
  ).href;

  return `import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from ${JSON.stringify(connectPlugin)};
import {
    READ_API_VERSION,
    READ_PROTOCOL,
    type ReadPlugin,
} from ${JSON.stringify(pluginProtocol)};
import type { ResourceResolver } from ${JSON.stringify(resourceApi)};

const resolver = {
    id: "${pluginId}-resolver",
    async tryResolve(source) {
        if (source !== "${supportedSource}") {
            return { kind: "not-handled" };
        }

        return {
            kind: "resolved",
            resource: {
                source,
                async read() {
                    return [{ type: "text", text: "${resultText}" }];
                },
            },
        };
    },
} satisfies ResourceResolver;

const plugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "${pluginId}",
    ${setup},
} satisfies ReadPlugin;

export default async function registerPlugin(pi: ExtensionAPI): Promise<void> {
    await connectReadPlugin(pi, plugin);
}
`;
}

function reexportSource(source: string): string {
  if (!source.startsWith("#src/")) {
    throw new Error(`Unsupported generated extension import: ${source}`);
  }

  const relativePath = source.slice("#src/".length).replace(/\.js$/, ".ts");
  return `export { default } from ${JSON.stringify(packageModuleUrl(`src/${relativePath}`))};\n`;
}

function packageModuleUrl(relativePath: string): string {
  return pathToFileURL(path.join(packageRoot, relativePath)).href;
}
