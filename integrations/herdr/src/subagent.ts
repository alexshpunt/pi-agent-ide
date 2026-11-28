import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ResourceError } from "pi-agent-ide/api/resource";
import { failure, type RecoveryReceipt } from "./service.ts";
import { oneLine } from "./timeline.ts";
import {
  NESTING_LIMIT,
  namePattern,
  type ReplicaDetails,
  type ReplicaWatcher,
} from "./replicate.ts";

export interface SubagentDetails extends ReplicaDetails {
  kind: "subagent";
  profile: string;
  model?: string;
  folder: string;
  outcome: string;
}
/** The startup receipt Herdr returns for a workflow-profile launch. */
interface Receipt {
  outcome?: unknown;
  terminal?: unknown;
  space?: unknown;
  tab?: unknown;
  model?: unknown;
  detail?: unknown;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** True when one folder holds the other, so both agents change the same working tree. */
export function overlaps(a: string, b: string): boolean {
  const inside = (child: string, parent: string) => {
    const relative = path.relative(parent, child);
    // oxlint-disable-next-line repo/no-parent-paths -- checks a relative path without traversing it
    return relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative);
  };
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return inside(x, y) || inside(y, x);
}

/** Tell the sub-agent who started it and how it works before its assignment. */
export function subagentAssignment(name: string, task: string, sharedFolder: boolean): string {
  return [
    `You are a sub-agent started with subagent as "${name}" by another agent for a side task of its work. That agent receives your timeline each time you stop and answers your messages; it closes you when your work is done.`,
    "",
    "Rules for a sub-agent:",
    "- Complete only the assignment below.",
    "- Do not ask the user. When you need a decision, end your turn with the question; the agent that started you answers with a message.",
    ...(sharedFolder
      ? [
          "- You work in the same directory tree as the agent that started you, and it changes other files at the same time. Change only the files your assignment covers, and do not commit or change Git state unless your assignment says so.",
        ]
      : []),
    "- When you finish, stop with a final message: the result, the files you changed, and what is left or failed.",
    "",
    "Your assignment:",
    task,
  ].join("\n");
}

/** Register the subagent tool; its agents are followed by the same watcher as replicas. */
export function registerSubagent(
  pi: ExtensionAPI,
  watcher: ReplicaWatcher,
  owner: () => string,
): void {
  pi.registerTool({
    name: "subagent",
    label: "Sub-agent",
    description:
      "Use subagent to hand a side track of your work, such as research, a search or an isolated task, to a fresh agent in a new Herdr tab, so your own context stays on your task. It starts without your conversation, with the workflow profile you choose. Each time it stops, its timeline arrives here as a message until you close it.",
    promptSnippet:
      "Hand a side track that does not need your context, such as research or an isolated task, to a fresh agent you follow.",
    promptGuidelines: [
      "Use subagent for side work that does not need your context: research, a search, an investigation or an isolated task. For a part of your own task that needs your context, use replicate; for an independent task for the user, use agent.",
      "Read herdr:profiles before starting a sub-agent, and choose the profile whose description fits the side task.",
      "Write the task so that it stands alone: the sub-agent knows nothing of your conversation. Name what to find out or do, where, and the result you expect back.",
      "Start independent side tracks together and continue your own work. Each time a sub-agent stops, its timeline arrives as a message: answer its question or steer it with write to its herdr: address, and close it with delete once its result is in and checked. When nothing significant happened and the sub-agent keeps working, stay silent: end your turn without a message. Do not poll; after finishing your own work, end your turn.",
      "If you are a sub-agent, complete only your assignment and follow its rules, then stop with a final message: the result, the files you changed, and what is left or failed.",
    ],
    parameters: Type.Object(
      {
        name: Type.String({
          pattern: namePattern.source,
          description:
            "A task-specific name in lowercase kebab-case, such as research-gpui-tooltips. It names the sub-agent's tab.",
        }),
        task: Type.String({
          minLength: 1,
          description: "The complete, self-contained side task and the result you expect back.",
        }),
        profile: Type.String({
          minLength: 1,
          description:
            "Workflow profile ID from herdr:profiles; it selects the model and thinking level.",
        }),
        folder: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Absolute folder the sub-agent works in. Default: your directory.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme) {
      const profile = typeof args.profile === "string" ? ` · ${oneLine(args.profile)}` : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("muted", `${oneLine(args.name)}${profile}`)}`,
        0,
        0,
      );
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!namePattern.test(params.name))
        throw failure(
          "HERDR_INVALID_NAME",
          "herdr:",
          "Name the sub-agent in lowercase kebab-case, such as research-gpui-tooltips.",
        );
      if (!params.task.trim())
        throw failure("HERDR_INVALID_TASK", "herdr:", "Describe the sub-agent's task.");
      const folder = params.folder ?? ctx.cwd;
      if (!path.isAbsolute(folder) && !/^[A-Za-z]:[\\/]/u.test(folder))
        throw failure(
          "HERDR_INVALID_FOLDER",
          "herdr:",
          "Give the sub-agent an absolute folder, or omit folder to use yours.",
        );
      const since = Date.now();
      // One call is one launch: a retried call with the same ID reuses its receipt instead of starting a second agent.
      const requestId = `subagent-${ctx.sessionManager.getSessionId()}-${toolCallId}`;
      let receipt: Receipt;
      const receipts: RecoveryReceipt[] = [];
      try {
        receipt = await watcher.service.command<Receipt>(
          "agent.subagent",
          {
            requestId,
            name: params.name,
            folder,
            profile: params.profile,
            task: subagentAssignment(params.name, params.task, overlaps(folder, ctx.cwd)),
          },
          "herdr:",
          toolCallId,
          receipts,
        );
      } catch (error) {
        if (error instanceof ResourceError) throw error;
        const reason = messageOf(error);
        if (/Unsupported Herdr bridge command/iu.test(reason))
          throw failure(
            "HERDR_SUBAGENT_UNSUPPORTED",
            "herdr:",
            "Update Herdr App, then reload Pi to start sub-agents.",
          );
        if (NESTING_LIMIT.test(reason)) throw failure("HERDR_NESTING_LIMIT", "herdr:", reason);
        if (/Unknown workflow profile/u.test(reason))
          throw failure(
            "HERDR_UNKNOWN_PROFILE",
            "herdr:",
            reason.replace(/^agent\.subagent refused: /u, ""),
          );
        if (/^agent\.subagent (refused|needs|is unavailable)/u.test(reason))
          throw failure("HERDR_SUBAGENT_REFUSED", "herdr:", reason);
        // The App may have opened the tab before the reply was lost.
        throw failure(
          "HERDR_SUBAGENT_FAILED",
          "herdr:",
          `${reason}. Read herdr: before starting it again: the sub-agent may be running.`,
          "unknown",
        );
      }
      const outcome = typeof receipt.outcome === "string" ? receipt.outcome : "unknown";
      const detail = typeof receipt.detail === "string" ? `: ${oneLine(receipt.detail)}` : "";
      if (typeof receipt.terminal !== "string" || !receipt.terminal)
        throw failure(
          "HERDR_SUBAGENT_FAILED",
          "herdr:",
          `Herdr did not confirm the launch (${outcome}${detail}). Read herdr: before starting it again.`,
          "unknown",
        );
      const source = `herdr:${receipt.terminal}`;
      // A failed start leaves its tab for inspection; it is still this agent's to close.
      watcher.service.adopt(receipt.terminal);
      if (outcome === "model-failed" || outcome === "exited" || outcome === "unknown")
        throw failure(
          "HERDR_SUBAGENT_NOT_STARTED",
          source,
          `Sub-agent ${params.name} in ${source} did not start (${outcome}${detail}). Read it for the error and close it with delete.`,
        );
      const details: SubagentDetails = {
        terminal: receipt.terminal,
        name: params.name,
        owner: owner(),
        since,
        kind: "subagent",
        profile: params.profile,
        folder,
        outcome,
        herdrReceipts: receipts,
        ...(typeof receipt.model === "string" ? { model: receipt.model } : {}),
        ...(typeof receipt.space === "string" ? { space: receipt.space } : {}),
        ...(typeof receipt.tab === "string" ? { tab: receipt.tab } : {}),
      };
      watcher.follow(
        {
          terminal: details.terminal,
          name: details.name,
          kind: "subagent",
          since,
          restored: false,
        },
        ctx.cwd,
      );
      const model = details.model ? ` on ${details.model}` : "";
      const waiting =
        outcome === "started" ? "" : ` Its startup is ${outcome}; you hear when it stops.`;
      return {
        content: [
          {
            type: "text",
            text: `Sub-agent ${params.name} started in ${source}${model} (profile ${params.profile}), a new tab in your space, working in ${folder}.${waiting} Each time it stops, its timeline arrives here as a message. Steer it with write to ${source}; close it with delete once its result is in and checked.`,
          },
        ],
        details,
      };
    },
  });
}
