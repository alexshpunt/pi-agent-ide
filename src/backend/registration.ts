import { connectIdePlugin } from "#src/api/connect-plugin.js";
import { IDE_PROTOCOL, IDE_API_VERSION } from "#src/api/plugin-protocol.js";
import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";
import { createSshSearchEnvironmentProvider } from "./search-environment.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";
import { createReadResultRenderer } from "pi-agent-read/api/rendering";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";
import { createContentHost } from "pi-agent-resource";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";

import { createSshFileOperationResolver } from "./file-operation-resolver.js";
import { remoteLocation } from "./identity.js";
import { SshBackendRegistry } from "./registry.js";
import { createSshResourceResolver } from "./resource-resolver.js";
import type { SshTarget } from "./ssh.js";

/** Connect explicitly configured targets to the existing tools, without startup connections. */
export async function registerSshResources(
  pi: ExtensionAPI,
  targets: readonly SshTarget[],
): Promise<void> {
  const guide = await loadPackagedAgentGuide({
    id: "ssh",
    description: "Set up SSH targets and use remote resources",
    triggers: [
      { tool: "read", resourcePrefixes: ["ssh://", "raw:ssh://", "ast:ssh://", "web:ssh://"] },
      { tool: "search", resourcePrefixes: ["ssh://", "web:ssh://"] },
      { tool: "debug", resourcePrefixes: ["ssh://"] },
      ...["write", "replace", "insert", "delete", "copy", "move", "stage", "unstage", "undo"].map(
        (tool) => ({
          tool,
          resourcePrefixes: ["ssh://"],
        }),
      ),
    ],
  });
  connectAgentDocumentation(pi, [
    {
      ...guide,
      markdown: `${guide.markdown}\n## Configured workspaces\n\n${targets.length === 0 ? "No SSH targets are configured. Follow the setup steps above." : targets.map((target) => `- \`${remoteLocation(target.id, target.workspace).source}\``).join("\n")}\n`,
    },
  ]);
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "ssh-guidance",
    setup(api) {
      api.addPromptGuideline(
        "When the user asks to connect to or work on a remote device or environment over SSH, read docs:ssh first and follow its setup and usage steps.",
      );
    },
  });
  if (targets.length === 0) return;
  const registry = new SshBackendRegistry(targets);
  // Reuse installed byte converters; readable images/PDFs never become writable text.
  const readHost = createContentHost(pi, { provider: "filesystem", capability: "read" });
  const writeHost = createContentHost(pi, { provider: "filesystem", capability: "write" });
  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "ssh",
    setup(api) {
      api.addResolver({
        resolver: createSshResourceResolver(registry, readHost, "read"),
        priority: -50,
        preserveTruncatedOutput: true,
        renderResult: createReadResultRenderer({ kind: "source" }),
      });
    },
  } satisfies ReadPlugin;
  const editorPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "ssh",
    setup(api) {
      api.addFileOperationResolver(createSshFileOperationResolver(registry));
      api.addResolver({
        resolver: createSshResourceResolver(registry, writeHost, "write"),
        priority: -50,
      });
    },
  } satisfies TextEditorPlugin;
  await Promise.all([
    connectIdePlugin(pi, {
      protocol: IDE_PROTOCOL,
      apiVersion: IDE_API_VERSION,
      id: "ssh-diagnostic-files",
      setup(api) {
        api.addDiagnosticFileReader({
          id: "ssh",
          async readText(source, context) {
            const owner = registry.resolve(source, context.cwd);
            if (!owner) return undefined;
            return (
              await owner.backend.read(owner.location.path, { signal: context.signal })
            ).bytes.toString("utf8");
          },
        });
      },
    }),
    connectReadPlugin(pi, readPlugin),
    connectTextEditorPlugin(pi, editorPlugin),
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "ssh",
      setup(api) {
        api.addEnvironmentProvider(createSshSearchEnvironmentProvider(registry));
      },
    }),
  ]);
}
