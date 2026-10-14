import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmOperation } from "#src/api/approval.js";
import { registerAgentIdeSettings } from "#src/api/settings.js";

interface BlockedState {
  readonly active: boolean;
  readonly label?: string;
}
interface OpenDialog {
  readonly message: string;
  readonly blockedAtOpen: BlockedState | undefined;
  readonly mutationAtOpen: boolean;
}
interface ApprovalState {
  readonly blocked: BlockedState[];
  readonly opened: OpenDialog[];
  readonly effects: string[];
}

/** Scripted answers at Pi's host UI boundary; no approval flag is supplied to a production tool. */
export default function operationApprovalFixture(pi: ExtensionAPI): void {
  registerAgentIdeSettings(pi, "fixture", [
    {
      id: "fixture-yolo",
      kind: "boolean",
      name: "Fixture YOLO",
      description: "Test-only operation approval setting.",
      default: false,
    },
  ]);
  pi.registerCommand("approval_yolo_probe", {
    description: "Test-only effective YOLO policy probe.",
    async handler(_args, context) {
      const approved = await confirmOperation(pi.events, context, {
        owner: "fixture",
        category: "yolo",
        yoloSetting: "fixture-yolo",
        title: "Confirm YOLO fixture",
        message: "harmless policy probe",
      });
      await writeFile(
        path.join(context.cwd, "yolo-result.json"),
        JSON.stringify({ approved, hasUI: context.hasUI }),
      );
    },
  });
  const state: ApprovalState = { blocked: [], opened: [], effects: [] };
  pi.events.on("herdr:blocked", (event) => {
    state.blocked.push(event as BlockedState);
  });
  const persist = (cwd: string): Promise<void> =>
    writeFile(path.join(cwd, "operation-approval-state.json"), JSON.stringify(state, null, 2));
  const exists = async (source: string): Promise<boolean> => {
    try {
      await access(source);
      return true;
    } catch {
      return false;
    }
  };

  pi.registerTool({
    name: "approval_probe",
    label: "Shared approval fixture",
    description: "Test-only harmless operation routed through the public shared approval service.",
    parameters: Type.Object({ fixture: Type.String() }),
    async execute(_id, { fixture: target }, signal, _update, context) {
      if (
        ![
          "direct-yes",
          "direct-no",
          "script-yes",
          "script-no",
          "abort",
          "throw",
          "parallel",
          "headless",
        ].includes(target)
      )
        throw Error("Unknown controlled approval target");
      const controller = new AbortController();
      const ownedSignal =
        signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
      let resolveFirst: ((value: boolean) => void) | undefined;
      let markFirstReady: () => void = () => {};
      const firstReady = new Promise<void>((resolve) => {
        markFirstReady = resolve;
      });
      let firstFinished = false;
      let secondOpenedAfterFirst = false;
      const select: ExtensionContext["ui"]["select"] = async (title) => {
        const message = title.split("\n")[1] ?? "";
        state.opened.push({
          message,
          blockedAtOpen: state.blocked.at(-1),
          mutationAtOpen: await exists(path.join(context.cwd, `${target}.effect`)),
        });
        if (target === "headless") throw Error("Headless service called UI");
        if (target === "throw") throw Error("Controlled dialog failure");
        if (target === "abort") {
          controller.abort();
          return "Allow once";
        }
        if (target === "parallel") {
          if (message.endsWith("first"))
            return new Promise<string | undefined>((resolve) => {
              resolveFirst = (value) => resolve(value ? "Allow once" : "Deny");
              markFirstReady();
            });
          secondOpenedAfterFirst = firstFinished;
          return "Deny";
        }
        return message.endsWith("-yes") ? "Allow once" : "Deny";
      };
      const approvalContext = { ...context, ui: { select } };
      const ask = (message: string): Promise<boolean> =>
        confirmOperation(pi.events, approvalContext, {
          owner: "fixture",
          category: "controlled",
          title: "Confirm fixture operation",
          message,
          signal: ownedSignal,
        });
      const openedBefore = state.opened.length;
      const blockedBefore = state.blocked.length;
      let approved: boolean;
      let decisions: readonly boolean[] | undefined;
      if (target === "parallel") {
        const first = ask("parallel-first");
        const second = ask("parallel-second");
        // The host callback performs an awaited file check before exposing its deferred answer.
        await firstReady;
        if (resolveFirst === undefined) throw Error("First approval dialog did not open");
        if (state.opened.length !== openedBefore + 1) throw Error("Approval dialogs overlapped");
        firstFinished = true;
        resolveFirst(true);
        decisions = await Promise.all([first, second]);
        approved = decisions[0] === true;
      } else {
        approved = await ask(target);
      }
      if (approved) {
        await writeFile(path.join(context.cwd, `${target}.effect`), target);
        state.effects.push(target);
      }
      await persist(context.cwd);
      return {
        content: [{ type: "text", text: `${target}: ${approved ? "applied" : "not-applied"}` }],
        details: {
          target,
          approved,
          mode: context.mode,
          hasUI: context.hasUI,
          opened: state.opened.slice(openedBefore),
          blocked: state.blocked.slice(blockedBefore),
          ...(decisions === undefined ? {} : { decisions, secondOpenedAfterFirst }),
        },
      };
    },
  });

  pi.registerCommand("approval_cleanup_probe", {
    description: "Test-only pair of pending approvals for runtime shutdown coverage.",
    async handler(_args, context) {
      const cwd = context.cwd;
      const current = confirmOperation(pi.events, context, {
        owner: "fixture",
        category: "controlled",
        title: "Confirm current fixture",
        message: "cleanup-current",
      });
      const queued = confirmOperation(pi.events, context, {
        owner: "fixture",
        category: "controlled",
        title: "Confirm queued fixture",
        message: "cleanup-queued",
      });
      const decisions = await Promise.all([current, queued]);
      if (decisions.some(Boolean)) {
        await writeFile(path.join(cwd, "unexpected-cleanup.effect"), "not allowed");
        state.effects.push("unexpected-cleanup");
      }
      await persist(cwd);
      await writeFile(path.join(cwd, "approval-cleanup-result.json"), JSON.stringify(decisions));
    },
  });
  pi.registerCommand("approval_session_probe", {
    description: "Test-only session grant lifecycle probe.",
    async handler(category, context) {
      const approved = await confirmOperation(pi.events, context, {
        owner: "fixture",
        category: category || "delete",
        title: "Confirm session fixture",
        message: "harmless session probe",
      });
      await writeFile(
        path.join(context.cwd, "session-permission-result.json"),
        JSON.stringify({ approved }),
      );
    },
  });
  let response = 0;
  pi.registerProvider("approval-fixture", {
    name: "Local operation approval fixture",
    baseUrl: "https://approval-fixture.invalid",
    apiKey: "fixture",
    api: "openai-completions",
    models: [
      {
        id: "headless",
        name: "Headless approval fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model) {
      const first = response++ === 0;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: first
          ? [
              {
                type: "toolCall",
                id: "headless-approval",
                name: "approval_probe",
                arguments: { fixture: "headless" },
              },
            ]
          : [{ type: "text", text: "Headless approval fixture finished." }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: first ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
}
