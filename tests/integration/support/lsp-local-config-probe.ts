import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LspServerRegistry } from "#src/plugins/pi-agent-ide-lsp/src/lsp/registry.js";
import { inspectRecipeEvidence } from "pi-agent-doctor/api/evidence";
import {
  hasConfiguredExecutable,
  resolveExternalToolProjectRoot,
  toolRuntimeEvidence,
} from "pi-agent-ide/api/tool-config";

/** Cancel a real local config read, then load the same project without a poisoned registry. */
export async function probeLocalLspConfigCancellation(
  project: string,
  serverScript: string,
): Promise<{
  project: string;
  cancellationRetained: boolean;
  retrySelectedOwnedServer: boolean;
}> {
  const directory = path.join(project, ".pi", "pi-agent-ide");
  await mkdir(directory, { recursive: true });
  const config = path.join(directory, "lsp-servers.json");
  await writeFile(config, `${" ".repeat(8 * 1024 * 1024)}{invalid`);
  const controller = new AbortController();
  const cancellation = new Error("Cancel owned local registry read");
  const pending = LspServerRegistry.fromPackageDir(project, {
    includeGlobal: false,
    signal: controller.signal,
  }).catch((error: unknown) => error);
  controller.abort(cancellation);
  const report = await pending;
  if (report !== cancellation)
    throw new Error("Local registry lost its cancellation reason", { cause: report });
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      servers: {
        owned: {
          command: ["python3", serverScript],
          rootMarkers: [],
          languages: { typescript: { extensions: [".ts"] } },
          capabilities: [],
        },
      },
    }),
  );
  await writeFile(path.join(project, "note.ts"), 'const label = "café";\n');
  const registry = await LspServerRegistry.fromPackageDir(project, {
    includeGlobal: false,
    requireBuiltInEvidence: true,
  });
  const retrySelectedOwnedServer = registry.resolve(".ts")[0]?.serverId === "owned";
  if (!retrySelectedOwnedServer)
    throw new Error("Local registry retry did not select its owned server");
  return { project, cancellationRetained: true, retrySelectedOwnedServer };
}

/** Check cancellation during actual native discovery, availability and manifest buffering. */
export async function probeLocalLspDiscoveryCancellation(project: string): Promise<{
  projectDiscoveryRetained: boolean;
  executableCheckRetained: boolean;
  runtimeEvidenceRetained: boolean;
  manifestReadRetained: boolean;
}> {
  const observe = async (
    operation: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<boolean> => {
    const controller = new AbortController();
    const reason = new Error("Cancel owned native discovery");
    const pending = operation(controller.signal).catch((error: unknown) => error);
    controller.abort(reason);
    const report = await pending;
    if (report !== reason)
      throw new Error("Native discovery lost its cancellation reason", { cause: report });
    return true;
  };
  const projectDiscoveryRetained = await observe((signal) =>
    resolveExternalToolProjectRoot(
      path.join(project, "current"),
      path.join(project, "note.ts"),
      "lsp-servers",
      [],
      signal,
    ),
  );
  const executableCheckRetained = await observe((signal) =>
    hasConfiguredExecutable({ command: [process.execPath] }, project, process.env, signal),
  );
  const runtimeEvidenceRetained = await observe((signal) =>
    toolRuntimeEvidence(project, [{ id: "owned", config: { command: [process.execPath] } }], [], {
      includeGlobal: false,
      signal,
    }),
  );
  const manifest = path.join(project, "package.json");
  await writeFile(manifest, `${" ".repeat(8 * 1024 * 1024)}{}`);
  const manifestReadRetained = await observe((signal) =>
    inspectRecipeEvidence(project, [], undefined, signal),
  );
  await writeFile(manifest, "{}");
  await inspectRecipeEvidence(project, []);
  return {
    projectDiscoveryRetained,
    executableCheckRetained,
    runtimeEvidenceRetained,
    manifestReadRetained,
  };
}
