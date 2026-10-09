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

The hook receives one complete plan after Resource and anchor resolution but before the first write. It covers standalone mutation tools, including calls through native Codemode. A denial or thrown error leaves every Resource unchanged.

## Protect whole objects from deletion

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectBeforeDeleteHook } from "pi-agent-ide/api/hooks";

export default function (pi: ExtensionAPI) {
  connectBeforeDeleteHook(pi, {
    id: "protect-data",
    run(event) {
      return event.resolvedPath.endsWith("/data")
        ? { decision: "deny", reason: "Keep the data directory" }
        : { decision: "allow" };
    },
  });
}
```

This hook covers whole-object Delete calls for regular files, directories, and symlinks, plus directory/symlink Move source removal and existing destination removal. Both standalone and native Codemode calls use it. It does not cover selected-text removal, terminal/debugger actions, Copy, or ordinary-file Move. The event provides `path` (absolute requested path), `resolvedPath` (parent symlinks resolved, final symlink left alone), `cwd`, `kind`, `recursive`, and an optional abort `signal`. It runs once before removal and any user dialog. A denial or thrown error blocks removal; allowing does not override another hook or built-in protection.

Delete removes directories recursively and unlinks symlinks, including broken ones, without traversing their targets. The built-in policy uses the Git worktree containing Pi's cwd. Tracked or newly staged targets require a user dialog. External directories and symlinks and targets without a Git worktree require a dialog unless they are eligible descendants of a [temporary root](./configuration.md#temporary-directory-deletion). Failed Git checks inside the current project still require a dialog. Untracked directories and symlinks inside that worktree need no dialog. Ordinary files keep their existing policy.

The dialog names the exact target, reason, and operation. Refusal, dismissal, cancellation, or an unavailable dialog prevents removal. Project roots, their ancestors, filesystem roots, and current Git control paths are always blocked, even when a hook allows. Git control protection also covers regular-file `.git` markers. Without Git, cwd and its ancestors are protected.

Delete checks the target identity and policy again after hooks and confirmation. Changed targets need a new request; there is no agent approval flag. These checks are not an atomic lock against other processes changing the filesystem. Recursive deletion has no rollback: a filesystem error after removal begins reports `unknown` effects, because some entries may already be gone.

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
