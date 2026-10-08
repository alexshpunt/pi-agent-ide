import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebWithOwner } from "#src/extensions/pi-agent-read/extensions/pi-agent-web/index.js";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.js";
import { readSshTargets, resolveSshConfigPaths } from "./config.js";
import { SshBackendRegistry } from "./registry.js";
import { createSshWebResolver } from "./web-owner.js";

/** Register explicit target web reads without changing the egress of ordinary URLs. */
export default async function registerOwnedWeb(pi: ExtensionAPI): Promise<void> {
  const registry = new SshBackendRegistry(
    await readSshTargets(resolveSshConfigPaths(resolvePiAgentIdeExtensionsConfigPaths())),
  );
  await registerWebWithOwner(pi, (host) => createSshWebResolver(host, registry));
}
