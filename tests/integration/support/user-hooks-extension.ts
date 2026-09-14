import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  connectAfterEditHook,
  connectBeforeEditHook,
  connectBeforeReadHook,
} from "#src/api/hooks.js";

export default function (pi: ExtensionAPI) {
  void connectBeforeReadHook(pi, {
    id: "deny-secret",
    run: ({ resourceSource }) => {
      if (resourceSource.endsWith("throw.txt")) throw new Error("read hook exploded");
      return resourceSource.endsWith("secret.txt")
        ? { decision: "deny", reason: "fixture secret" }
        : { decision: "allow" };
    },
  });
  void connectBeforeEditHook(pi, {
    id: "deny-locked",
    run: ({ resources }) => {
      if (resources.some(({ resourceSource }) => resourceSource.endsWith("fail-edit.txt")))
        throw new Error("edit hook exploded");
      return resources.some(({ resourceSource }) => resourceSource.endsWith("locked.txt"))
        ? { decision: "deny", reason: "fixture lock" }
        : { decision: "allow" };
    },
  });
  void connectAfterEditHook(pi, {
    id: "saved-check",
    run: ({ after }) => {
      if (after.content.includes("explode-after")) throw new Error("after hook exploded");
      return after.content.includes("review")
        ? { feedback: "Saved edit needs review", tone: "warning" }
        : undefined;
    },
  });
}
