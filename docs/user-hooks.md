# File hooks

File hooks are ordinary Pi extensions. Put one in `.pi/extensions/*.ts` for a trusted project or `~/.pi/agent/extensions/*.ts` for every project, then run `/reload`.

## Protect a file from reads

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectBeforeReadHook } from "pi-agent-ide/api/hooks";

export default function (pi: ExtensionAPI) {
  connectBeforeReadHook(pi, {
    id: "protect-env",
    run(event) {
      return event.resourceSource.endsWith("/.env")
        ? { decision: "deny", reason: "Environment files are private" }
        : { decision: "allow" };
    },
  });
}
```

The hook receives the resolved Resource identity before its content is read. It covers normal, anchored, typed, raw, and script reads. A denial or thrown error blocks the read.

## Protect files from edits

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectBeforeEditHook } from "pi-agent-ide/api/hooks";

export default function (pi: ExtensionAPI) {
  connectBeforeEditHook(pi, {
    id: "protect-lockfiles",
    run(event) {
      const locked = event.resources.find(({ resourceSource }) =>
        resourceSource.endsWith("/pnpm-lock.yaml"),
      );
      return locked
        ? { decision: "deny", reason: "Use pnpm to update the lockfile" }
        : { decision: "allow" };
    },
  });
}
```

The hook receives one complete plan after Resource and anchor resolution but before the first write. It covers standalone mutation tools and Apply. A denial or thrown error leaves every Resource unchanged.

## Check saved edits

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectAfterEditHook } from "pi-agent-ide/api/hooks";

export default function (pi: ExtensionAPI) {
  connectAfterEditHook(pi, {
    id: "remind-tests",
    run(event) {
      if (event.resourceSource.endsWith(".ts") && event.after.content.includes("TODO")) {
        return { feedback: "The saved file still contains a TODO", tone: "warning" };
      }
    },
  });
}
```

This hook runs after post-processing and the final reread. Feedback appears in the agent result and beside the diff. Errors are reported as feedback; a successful write is never rolled back.

Hooks run in registration order. The first denial stops a before hook chain. IDs must be unique within each hook kind. Registrations belong to the Pi session and are removed on shutdown or reload.
