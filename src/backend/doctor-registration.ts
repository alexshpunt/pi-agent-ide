import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDoctorWithOwner } from "#src/doctor/extension.js";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.js";
import { readSshTargets, resolveSshConfigPaths } from "./config.js";
import { createSshDoctorWorkspace } from "./doctor-workspace.js";
import { SshBackendRegistry } from "./registry.js";

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
