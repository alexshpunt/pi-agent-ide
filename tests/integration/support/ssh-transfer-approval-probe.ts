import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectBeforeDeleteHook } from "#src/api/hooks.js";
import { SshBackend, type SshTarget } from "#src/backend/ssh.js";

/** Test-only host decisions and owner observations; never installed in live verification. */
export default function (pi: ExtensionAPI) {
  void connectBeforeDeleteHook(pi, {
    id: "object-transfer-approval-probe",
    async run(event) {
      await appendFile(
        path.join(process.cwd(), "transfer-hooks.jsonl"),
        JSON.stringify(event) + "\n",
      );
      return { decision: "allow" };
    },
  });
  pi.on("tool_call", (_event, ctx) => {
    ctx.ui.confirm = async (_title, message) => {
      const approved = !message.includes("tracked-no");
      await appendFile(
        path.join(ctx.cwd, "transfer-dialogs.jsonl"),
        JSON.stringify({ message, approved }) + "\n",
      );
      if (message.startsWith("ssh://right/") && message.includes("tracked-race")) {
        const config = JSON.parse(
          await readFile(path.join(ctx.cwd, ".pi/pi-agent-ide/ssh.json"), "utf8"),
        ) as { targets: SshTarget[] };
        const source = config.targets.find((target) => target.id === "left");
        if (!source) throw Error("Missing fixture owner");
        const result = await new SshBackend(source).execute(
          "python3",
          [
            "-c",
            "import pathlib,os,sys;p=sys.argv[1];os.rename(p,p+'-previous');os.mkdir(p);pathlib.Path(p,'data').write_text('replacement')",
            path.posix.join(source.workspace, "source-tracked-race"),
          ],
          source.workspace,
        );
        if (result.exitCode !== 0) throw Error("Unable to change approved fixture source");
      }
      return approved;
    };
  });
}
