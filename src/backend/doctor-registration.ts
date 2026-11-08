import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDoctorWithOwner } from "#src/doctor/extension.ts";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.ts";
import { readSshTargets, resolveSshConfigPaths } from "./config.ts";
import { createSshDoctorWorkspace } from "./doctor-workspace.ts";
import { SshBackendRegistry } from "./registry.ts";

/** Connect Doctor to explicit configured projects without any SSH probe during local startup. */
export default async function registerOwnedDoctor(pi: ExtensionAPI): Promise<void> {
  const registry = new SshBackendRegistry(
    await readSshTargets(resolveSshConfigPaths(resolvePiAgentIdeExtensionsConfigPaths())),
  );
  await registerDoctorWithOwner(pi, (source) =>
    source.startsWith("ssh://")
      ? createSshDoctorWorkspace(registry, source)
      : Promise.resolve(undefined),
  );
}
