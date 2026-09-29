import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { activeReleaseBranches } from "./merge-policy.ts";

/** Merge public main back into develop without rewriting either branch. */
export function synchronizeDevelop(cwd = process.cwd()): void {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  git("fetch", "--no-tags", "origin", "main", "develop");
  if (git("rev-list", "--count", "origin/develop..origin/main") === "0") return;
  git("switch", "--detach", "origin/develop");
  git("merge", "--no-ff", "--no-edit", "origin/main");
  git("push", "origin", "HEAD:develop");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const refs = execFileSync("git", ["ls-remote", "origin", "refs/heads/release/*"], {
    encoding: "utf8",
  });
  if (process.env.SKIP_ACTIVE_RELEASE === "true" && activeReleaseBranches(refs).length > 0) {
    console.log(
      "A release is active; develop will be synchronized after publication or cancellation",
    );
  } else {
    synchronizeDevelop();
  }
}
