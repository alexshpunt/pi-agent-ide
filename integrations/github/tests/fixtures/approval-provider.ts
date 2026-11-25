import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import pullsFixture, { type PullsState } from "./pulls-provider.ts";

/** Exercise production GitHub permission hooks against the existing local HTTP fixture. */
export default async function approvalFixture(pi: ExtensionAPI): Promise<void> {
  const waiting: unknown[] = [];
  const decisions: { title: string; message: string; waiting: unknown; requestsBefore: number }[] = [];
  pi.events.on("herdr:blocked", (event) => waiting.push(event));
  pi.on("tool_call", (_event, context) => {
    context.ui.select = async (dialog, choices) => {
      const [title, ...lines] = dialog.split("\n");
      const message = lines.join("\n");
      const statePath = path.join(context.cwd, "pulls-fixture.json");
      const load = async (): Promise<PullsState> => JSON.parse(await readFile(statePath, "utf8"));
      const requestsBefore = (await load()).requests.length;
      const active = waiting.at(-1) as { active?: boolean } | undefined;
      if (active?.active !== true) throw new Error("GitHub popup preceded shared waiting");
      decisions.push({ title: title!, message, waiting: active, requestsBefore });
      await new Promise<void>((resolve) => setImmediate(resolve));
      if ((await load()).requests.length !== requestsBefore)
        throw new Error("GitHub HTTP request preceded the decision");
      if (message.includes("dialog-failure")) throw new Error("Controlled UI failure");
      const answer = message.includes("refuse") ? "Deny"
        : message.includes("remember-session") ? "Allow for session" : "Allow once";
      if (!choices.includes(answer)) throw new Error(`Missing approval choice: ${answer}`);
      return answer;
    };
  });
  const save = async (_event: unknown, context: ExtensionContext) => {
    await writeFile(path.join(context.cwd, "approval-state.json"), JSON.stringify({ waiting, decisions }, null, 2));
  };
  pi.on("tool_result", save);
  // A blocked tool_call does not emit tool_result; include the final denied decision too.
  pi.on("agent_settled", save);
  await pullsFixture(pi);
}
