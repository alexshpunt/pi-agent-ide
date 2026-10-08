import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import moveRollbackResource from "#integration/support/move-rollback-resource.js";

/** Use the isolated Move fault fixture without writing integration-test attempt logs. */
export default function moveRollbackFixture(pi: ExtensionAPI): Promise<void> {
  return moveRollbackResource(pi, false);
}
