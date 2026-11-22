import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Check the actual walker while Pi is still alive, before session teardown can stop it. */
export default function registerWalkerProbe(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "deadline_walker_probe",
    label: "Deadline walker probe",
    description: "Check whether the fixture walker is still running.",
    parameters: Type.Object({ scope: Type.Union([Type.Literal("local"), Type.Literal("ssh")]) }),
    async execute(_id, { scope }, _signal, _update, context) {
      const root =
        scope === "local"
          ? path.join(context.cwd, "slow-tree")
          : process.env.FILE_SEARCH_DEADLINE_REMOTE;
      if (root === undefined) throw new Error("Missing SSH fixture directory");
      const marker = await readFile(path.join(root, "walker.pid"), "utf8");
      const [pid, started] = marker.trim().split(" ");
      if (!pid || !started || !/^\d+$/u.test(pid))
        throw new Error(`Invalid walker identity: ${marker}`);
      const deadline = performance.now() + 5_000;
      let running: boolean;
      do {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch((error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return "";
          throw error;
        });
        const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
        running = fields[19] === started;
        if (running) await sleep(50);
      } while (running && performance.now() < deadline);
      return {
        content: [{ type: "text", text: JSON.stringify({ pid: Number(pid), running }) }],
        details: { pid: Number(pid), running },
      };
    },
  });
}
