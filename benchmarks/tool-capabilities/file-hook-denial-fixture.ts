import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectBeforeEditHook } from "#src/api/hooks.ts";

export default function fileHookDenialFixture(pi: ExtensionAPI): void | Promise<void> {
  return connectBeforeEditHook(pi, {
    id: "fixture-file-policy",
    run({ resources }) {
      return resources.some(({ resourceSource }) =>
        /(?:^|\/)hook-locked-(?:write\.txt|copy\/nested\/item\.txt|move\/nested\/item\.txt)$/u.test(
          resourceSource,
        ),
      )
        ? {
            decision: "deny",
            reason: "Policy marker: KEEP_EXISTING\nPolicy marker: SIBLING_CHECK?!",
          }
        : { decision: "allow" };
    },
  });
}
