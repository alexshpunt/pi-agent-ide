import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebWithOwner } from "#src/extensions/pi-agent-read/extensions/pi-agent-web/index.ts";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.ts";
import { readSshTargets, resolveSshConfigPaths } from "./config.ts";
import { SshBackendRegistry } from "./registry.ts";
import { createSshWebResolver } from "./web-owner.ts";

/** Register explicit target web reads without changing the egress of ordinary URLs. */
export default async function registerOwnedWeb(pi: ExtensionAPI): Promise<void> {
  const registry = new SshBackendRegistry(
    await readSshTargets(resolveSshConfigPaths(resolvePiAgentIdeExtensionsConfigPaths())),
  );
  await registerWebWithOwner(pi, (host) => createSshWebResolver(host, registry));
}
