import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePiAgentIdeExtensionsConfigPaths } from "#src/composite/extensions-config.js";
import { readSshTargets, resolveSshConfigPaths } from "./config.js";
import { registerSshResources } from "./registration.js";

/** Load explicitly configured SSH sources without opening startup connections. */
export default async function registerSshModule(pi: ExtensionAPI): Promise<void> {
  const targets = await readSshTargets(
    resolveSshConfigPaths(resolvePiAgentIdeExtensionsConfigPaths()),
  );
  await registerSshResources(pi, targets);
}
