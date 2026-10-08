import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  connectAfterEditHook,
  connectBeforeEditHook,
  connectBeforeReadHook,
} from "#src/api/hooks.js";

/** Trusted controller hooks record only fixture identities and synthetic application content. */
export default async function (pi: ExtensionAPI): Promise<void> {
  const record = async (cwd: string, event: unknown) => {
    await mkdir(path.join(cwd, ".tmp"), { recursive: true });
    await appendFile(path.join(cwd, ".tmp/hook-events.jsonl"), JSON.stringify(event) + "\n");
  };
  await connectBeforeReadHook(pi, {
    id: "ssh-fixture-read-policy",
    async run(event) {
      await record(event.cwd, {
        kind: "beforeRead",
        source: event.resourceSource,
        requested: event.requestedSource,
        audience: event.audience,
        resolvedBy: event.resolvedBy,
      });
      if (!/^(?:raw:|ast:)?ssh:\/\/fixture\//u.test(event.resourceSource))
        return { decision: "allow" };
      if (event.resourceSource.endsWith("/throw.txt")) throw new Error("Owned read hook refused");
      return /\/secret\.(?:json|ts)$/u.test(event.resourceSource)
        ? { decision: "deny", reason: "Owned remote content is blocked" }
        : { decision: "allow" };
    },
  });
  await connectBeforeEditHook(pi, {
    id: "ssh-fixture-edit-policy",
    async run(event) {
      await record(event.cwd, {
        kind: "beforeEdit",
        intent: event.intent,
        resources: event.resources.map((resource) => ({
          source: resource.resourceSource,
          existed: resource.existed,
          before: resource.before.content,
          after: resource.after.content,
          ...(resource.binary === undefined
            ? {}
            : {
                binary: {
                  before: Array.from(resource.binary.before),
                  after: Array.from(resource.binary.after),
                },
              }),
        })),
      });
      return event.resources.some(
        (resource) =>
          resource.resourceSource.startsWith("ssh://fixture/") &&
          resource.resourceSource.endsWith("/locked.txt"),
      )
        ? { decision: "deny", reason: "Owned remote destination is locked" }
        : { decision: "allow" };
    },
  });
  await connectAfterEditHook(pi, {
    id: "ssh-fixture-saved-policy",
    async run(event) {
      await record(event.cwd, {
        kind: "afterEdit",
        source: event.resourceSource,
        requested: event.source,
        before: event.before.content,
        after: event.after.content,
      });
      if (event.after.content.includes("EXPLODE")) throw new Error("Owned saved hook failed");
      return event.after.content.includes("REVIEW")
        ? { feedback: "Owned review sees final " + event.after.content.trim(), tone: "warning" }
        : undefined;
    },
  });
}
