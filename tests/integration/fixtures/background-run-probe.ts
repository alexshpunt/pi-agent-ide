import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL } from "pi-agent-read/api/plugin-protocol";

interface BackgroundCase {
  mode: "terminal" | "review" | "queue" | "abort";
  view: string;
}

/** Exercises real custom-run boundaries with a late Read plugin and observable file effects. */
export default async function backgroundRunProbe(pi: ExtensionAPI): Promise<void> {
  const config = JSON.parse(await readFile(path.resolve("background-case.json"), "utf8")) as BackgroundCase;
  let firstSettlement = true;
  let customStarts = 0;
  let activeRuns = 0;
  let maxActiveRuns = 0;
  const starts: { kind: string | undefined; idle: boolean }[] = [];
  const settlements: { aborted: boolean; idle: boolean }[] = [];
  const record = (value: unknown) => appendFile(path.resolve("background-events.jsonl"), `${JSON.stringify(value)}\n`);

  pi.on("before_agent_start", async (event, context) => {
    // The regression runs on Pi 1.3 while the repository still typechecks with its older SDK.
    const kind = (event as { messageType?: string }).messageType;
    starts.push({ kind, idle: context.isIdle() });
    await record({ type: "before", kind, idle: context.isIdle() });
    if (kind !== "custom" || ++customStarts !== 1 || !["queue", "abort"].includes(config.mode)) return;
    pi.sendMessage(
      { customType: "startup-queued", content: "Queued during preparation", display: true },
      { triggerTurn: true, deliverAs: "steer" },
    );
    // Hold preparation open after delivery so a reentrant run has a chance to become observable.
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (config.mode === "abort") context.abort();
  });
  pi.on("agent_start", () => {
    maxActiveRuns = Math.max(maxActiveRuns, ++activeRuns);
  });
  pi.on("agent_end", () => {
    activeRuns -= 1;
  });
  pi.on("agent_settled", async (event, context) => {
    const aborted = (event as { aborted?: boolean }).aborted === true;
    settlements.push({ aborted, idle: context.isIdle() });
    await record({ type: "settled", aborted, idle: context.isIdle() });
    if (firstSettlement) {
      firstSettlement = false;
      await connectReadPlugin(pi, {
        protocol: READ_PROTOCOL,
        apiVersion: READ_API_VERSION,
        id: "background-late-view",
        setup(api) {
          api.addView({
            view: config.view,
            presenter: {
              id: "background-generation",
              present(document) {
                return {
                  ...document,
                  lines: document.lines.map((line) => ({
                    ...line,
                    presentation: { ...line.presentation, prefix: `${config.view}|` },
                  })),
                };
              },
            },
          });
          api.describe({ views: config.view });
        },
      });
      await writeFile(path.join(context.cwd, "background-release"), "released");
      if (config.mode === "queue" || config.mode === "abort") {
        pi.sendMessage(
          { customType: "fixture-wakeup", content: "Inspect the late view", display: true },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    } else if (config.mode === "abort" && aborted) {
      pi.sendMessage(
        { customType: "fixture-recovery", content: "Continue after startup cancellation", display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }
  });
  pi.registerTool({
    name: "background_probe",
    label: "Background lifecycle probe",
    description: "Save the observed run boundaries and acknowledge the background notification.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, context) {
      const customTypes = context.sessionManager.getBranch().flatMap((entry) =>
        entry.type === "custom_message" ? [entry.customType] : [],
      );
      const observation = { starts, settlements, maxActiveRuns, customTypes };
      await writeFile(path.join(context.cwd, "background-observation.json"), JSON.stringify(observation));
      return { content: [{ type: "text", text: JSON.stringify(observation) }], details: observation };
    },
  });
}
