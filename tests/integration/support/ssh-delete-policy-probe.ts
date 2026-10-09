import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectBeforeDeleteHook } from "#src/api/hooks.js";
import { SshBackend, type SshTarget } from "#src/backend/ssh.js";

/** Observe canonical owners and provide deterministic decisions at the host UI boundary. */
export default function (pi: ExtensionAPI) {
  void connectBeforeDeleteHook(pi, {
    id: "ssh-delete-owner-probe",
    async run(event) {
      if (!event.path.startsWith("ssh://fixture/")) return { decision: "allow" };
      await appendFile(
        path.join(process.cwd(), "delete-hooks.jsonl"),
        JSON.stringify({
          path: event.path,
          resolvedPath: event.resolvedPath,
          cwd: event.cwd,
          kind: event.kind,
          recursive: event.recursive,
        }) + "\n",
      );
      return event.path.endsWith("locked-delete")
        ? { decision: "deny", reason: "fixture deletion lock" }
        : { decision: "allow" };
    },
  });
  pi.on("tool_call", (_event, ctx) => {
    ctx.ui.confirm = async (_title, message) => {
      const approved = message.includes("tracked-yes") || message.includes("tracked-race");
      await appendFile(
        path.join(ctx.cwd, "dialog-decisions.jsonl"),
        JSON.stringify({ message, approved }) + "\n",
      );
      if (message.includes("tracked-race")) {
        const config = JSON.parse(
          await readFile(path.join(ctx.cwd, ".pi/pi-agent-ide/ssh.json"), "utf8"),
        ) as { targets: SshTarget[] };
        const target = config.targets[0];
        if (target === undefined) throw Error("Missing fixture target");
        const backend = new SshBackend(target);
        const source = path.posix.join(target.workspace, "tracked-race");
        const result = await backend.execute(
          "python3",
          [
            "-c",
            "import os,pathlib,sys; p=sys.argv[1]; os.rename(p,p+'-previous'); os.mkdir(p); pathlib.Path(p,'data').write_text('replacement')",
            source,
          ],
          target.workspace,
        );
        if (result.exitCode !== 0) throw Error("Unable to replace fixture deletion target");
      }
      return approved;
    };
  });
}
