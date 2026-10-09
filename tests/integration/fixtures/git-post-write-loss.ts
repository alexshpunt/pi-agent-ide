import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "pi-agent-text-editor/api/plugin-protocol";
import { createOwnedGitExecutor } from "#src/backend/git-registration.js";
import { readSshTargets, resolveSshConfigPaths } from "#src/backend/config.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.js";
import { gitSourceDirectory } from "#src/plugins/pi-agent-ide-changes/src/changes/git-paths.js";

/** Lose the acknowledgement only after a real owned text and Git index publication. */
export default async function (pi: ExtensionAPI): Promise<void> {
  const executor = createOwnedGitExecutor(pi, new SshBackendRegistry(
    await readSshTargets(resolveSshConfigPaths(resolvePiAgentIdeExtensionsConfigPaths())),
  ));
  await connectTextEditorPlugin(pi, {
    id: "git-post-write-loss-fixture",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addMutationTool({
        name: "restore_with_lost_reply",
        description: "Restore the owned fixture text and publish its Git index before losing the reply.",
        parameters: Type.Object({ path: Type.String() }),
        source: { field: "path" },
        intent: "restore",
        async mutate(context) {
          const source = context.sourceFor("path");
          if (!source.endsWith("/loss-owned.txt")) throw new Error("Not a fixture-owned source");
          return {
            edits: new Map([[source, {
              action: "edited",
              changes: [{ from: 0, to: context.sourceDocument.content.length, insert: "before\n" }],
            }]]),
            async afterWrite() {
              const result = await executor.exec("git", ["add", "--", "loss-owned.txt"], {
                cwd: gitSourceDirectory(source, context.cwd),
                ...(context.signal !== undefined && { signal: context.signal }),
              });
              if (result.code !== 0) throw new Error("Fixture index publication failed");
              throw Object.assign(new Error("Fixture publication acknowledgement lost"), {
                code: "CONNECTION_LOST", effect: "unknown",
              });
            },
          };
        },
      });
    },
  });
}
