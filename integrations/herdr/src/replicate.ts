import { rm } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ResourceError } from "pi-agent-ide/api/resource";
import { failure, sameTerminal, type Agent, type RecoveryReceipt } from "./service.ts";
import { writeReplicaSession, type ForkEntry, type ForkMessage } from "./fork.ts";
import { agentStatusOf, oneLine, statusOf, type Inspection, type Status } from "./timeline.ts";
import { signature, sleep, type AgentWaiter, type Target } from "./wait.ts";

export const REPLICA_MESSAGE = "herdr-replica";
export const REPLICA_CLOSED = "herdr-replica-closed";
export const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** Herdr's refusal of a replica or sub-agent of an agent that is already nested as deep as allowed. */
export const NESTING_LIMIT = /nesting stops at depth/u;
/** How long a new replica may take to start answering before the original hears that it did not start. */
const STARTUP_MS = 180_000;
/** How long a reloaded original retries Herdr before it reports a followed replica as gone. */
const RESTORE_MS = 60_000;

/** A replica copies its caller's conversation; a sub-agent starts fresh. The caller follows both the same way. */
export type HelperKind = "replica" | "subagent";
export interface ReplicaDetails {
  terminal: string;
  name: string;
  owner: string;
  since: number;
  kind?: HelperKind;
  session?: string;
  space?: string;
  tab?: string;
  herdrReceipts?: RecoveryReceipt[];
}
export interface ReplicaMessageDetails {
  terminal: string;
  name: string;
  owner: string;
  kind?: HelperKind;
  signature?: string;
  status: Status | "failed";
  final: boolean;
}
/** `since` is when the agent was started; `after` is the signature of the last state the caller was told about. */
export interface Replica {
  terminal: string;
  name: string;
  kind?: HelperKind;
  since?: number;
  after?: string;
  restored: boolean;
}
/** The tools whose results start a followed agent. */
const LAUNCH_TOOLS = new Map<unknown, HelperKind>([
  ["replicate", "replica"],
  ["subagent", "subagent"],
]);
const titleOf = (kind: HelperKind | undefined) => (kind === "subagent" ? "Sub-agent" : "Replica");

/** True once the replica has done anything since it was copied; before that it shows the original's inherited timeline. */
function begun(value: Inspection, since: number): boolean {
  return (
    statusOf(value) !== "idle" ||
    value.inspection.events.some((event) => Date.parse(event.at) > since)
  );
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Tell the replica who it is and how it works before its assignment. */
export function replicaAssignment(name: string, task: string): string {
  return [
    `You are a replica: a copy of the original agent, started with replicate as "${name}". Up to this message your conversation is a copy of the original's. The original continues its own work and receives your timeline each time you stop.`,
    "",
    "Rules for a replica:",
    "- Complete only the assignment below. Do not continue the original's other work.",
    "- You work in the original's directory, and the original and other replicas may change other parts of it at the same time. Change only the files your assignment covers. Do not fix, revert or reformat changes outside them. When a check fails because of code outside your assignment, report it instead of fixing it.",
    "- Do not commit or change Git state: no commit, stash, checkout, restore or reset. The original commits the combined result; this overrides any instruction to commit.",
    "- Do not ask the user. When you need a decision, end your turn with the question; the original answers with a message.",
    "- When you finish, stop with a final message: what you did, the files you changed, and what is left or failed.",
    "",
    "Your assignment:",
    task,
  ].join("\n");
}

/** Follows each replica of the current session and reports every new stop to it as a message. */
export class ReplicaWatcher {
  /** Followed agents by terminal: the watch to abort and what kind of agent it is. */
  private readonly follows = new Map<string, { controller: AbortController; kind: HelperKind }>();
  private readonly followed = new Set<string>();
  private context: ExtensionContext | undefined;
  constructor(
    private pi: ExtensionAPI,
    private waiter: AgentWaiter,
    private owner: () => string,
    private limits = { startupMs: STARTUP_MS, restoreMs: RESTORE_MS },
  ) {}

  get count(): number {
    return this.follows.size;
  }
  get service() {
    return this.waiter.service;
  }
  private updateStatus(): void {
    const kinds = [...this.follows.values()].map((follow) => follow.kind);
    const parts = [
      ["Replicas", kinds.filter((kind) => kind === "replica").length],
      ["Sub-agents", kinds.filter((kind) => kind === "subagent").length],
    ] as const;
    const text = parts
      .filter(([, count]) => count)
      .map(([label, count]) => `${label}: ${count}`)
      .join(" · ");
    this.context?.ui.setStatus("herdr-replicas", text || undefined);
  }

  /** Session start: forget other sessions' replicas and follow this session's open ones again. */
  restore(ctx: ExtensionContext): void {
    this.stopAll();
    this.followed.clear();
    this.reconcile(ctx);
  }

  /** Follow persisted recoveries without restarting watches that are already running. */
  reconcile(ctx: ExtensionContext): void {
    this.context = ctx;
    const owner = this.owner();
    const replicas = new Map<string, Replica>();
    const finished = new Set<string>();
    for (const source of ctx.sessionManager.getBranch()) {
      const entry = record(source);
      const message = record(entry?.message);
      const details = record(entry?.details ?? message?.details);
      if (
        entry?.type === "message" &&
        message?.role === "toolResult" &&
        LAUNCH_TOOLS.has(message.toolName) &&
        !message.isError &&
        details?.owner === owner &&
        typeof details.terminal === "string"
      )
        replicas.set(details.terminal, {
          terminal: details.terminal,
          name: String(details.name),
          kind: LAUNCH_TOOLS.get(message.toolName),
          restored: true,
          ...(typeof details.since === "number" ? { since: details.since } : {}),
        });
      else if (
        entry?.type === "custom_message" &&
        entry.customType === "herdr-recovery" &&
        Array.isArray(details?.helpers)
      ) {
        for (const value of details.helpers) {
          const helper = record(value);
          if (
            helper?.owner !== owner ||
            typeof helper.terminal !== "string" ||
            !helper.terminal ||
            (helper.kind !== "replica" && helper.kind !== "subagent")
          )
            continue;
          if (!replicas.has(helper.terminal) && !finished.has(helper.terminal))
            replicas.set(helper.terminal, {
              terminal: helper.terminal,
              name: typeof helper.name === "string" ? helper.name : helper.terminal,
              kind: helper.kind,
              restored: true,
            });
        }
      } else if (
        entry?.type === "custom_message" &&
        entry.customType === REPLICA_MESSAGE &&
        details?.owner === owner &&
        typeof details.terminal === "string"
      ) {
        const replica = replicas.get(details.terminal);
        if (details.final) {
          replicas.delete(details.terminal);
          finished.add(details.terminal);
        } else if (replica)
          replica.after = typeof details.signature === "string" ? details.signature : undefined;
      } else if (entry?.type === "custom" && entry.customType === REPLICA_CLOSED) {
        const data = record(entry.data);
        if (data?.owner === owner && typeof data.terminal === "string") {
          replicas.delete(data.terminal);
          finished.add(data.terminal);
        }
      }
    }
    for (const replica of replicas.values())
      if (!this.followed.has(replica.terminal)) this.follow(replica, ctx.cwd);
  }

  /** Follow a replica until it exits, is closed or the session changes. */
  follow(replica: Replica, cwd: string): void {
    this.followed.add(replica.terminal);
    this.follows.get(replica.terminal)?.controller.abort();
    const controller = new AbortController();
    this.follows.set(replica.terminal, { controller, kind: replica.kind ?? "replica" });
    this.waiter.service.adopt(replica.terminal);
    this.updateStatus();
    const owner = this.owner();
    // Any failure ends the watch; the original must hear that its replica is no longer followed.
    void this.run(replica, controller.signal, cwd, owner)
      .catch((error) =>
        this.deliver(
          replica,
          owner,
          controller.signal,
          `Following ${titleOf(replica.kind).toLowerCase()} ${replica.name} in herdr:${replica.terminal} failed: ${messageOf(error)}\nRead it, and call wait_for_agents for it when you need its next result.`,
          { status: "failed", final: true },
        ),
      )
      .catch(() => {
        /* Pi refused the message; nothing is left to tell. */
      })
      .finally(() => {
        if (this.follows.get(replica.terminal)?.controller === controller) {
          this.follows.delete(replica.terminal);
          this.updateStatus();
        }
      });
  }

  /** The original closed the replica, by its full or bare address: stop following it and keep that across reloads. */
  closed(address: string): void {
    const terminal = [...this.follows.keys()].find((key) => sameTerminal(key, address));
    if (terminal === undefined) return;
    this.follows.get(terminal)?.controller.abort();
    this.follows.delete(terminal);
    this.pi.appendEntry(REPLICA_CLOSED, { terminal, owner: this.owner() });
    this.updateStatus();
  }

  stopAll(): void {
    for (const { controller } of this.follows.values()) controller.abort();
    this.follows.clear();
    this.updateStatus();
  }

  private deliver(
    replica: Replica,
    owner: string,
    signal: AbortSignal,
    text: string,
    details: Omit<ReplicaMessageDetails, "terminal" | "name" | "owner">,
  ): void {
    // A closed replica or a replaced session must not hear about this replica any more.
    if (signal.aborted || owner !== this.owner()) return;
    this.pi.sendMessage<ReplicaMessageDetails>(
      {
        customType: REPLICA_MESSAGE,
        content: text,
        display: true,
        details: {
          terminal: replica.terminal,
          name: replica.name,
          owner,
          kind: replica.kind ?? "replica",
          ...details,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  private async run(
    replica: Replica,
    signal: AbortSignal,
    cwd: string,
    owner: string,
  ): Promise<void> {
    const source = `herdr:${replica.terminal}`;
    const listed = await this.start(replica, signal, owner);
    if (!listed) return;
    const target: Target = { source, terminal: replica.terminal, listed };
    let after = replica.after;
    for (;;) {
      const { observations, signature: current } = await this.waiter.settle(
        [target],
        signal,
        after,
      );
      if (signal.aborted) return;
      const value = observations[0].value;
      const status: Status = value ? statusOf(value) : "exited";
      const final = status === "exited";
      const head = final
        ? `${titleOf(replica.kind)} ${replica.name} in ${source} exited.`
        : `${titleOf(replica.kind)} ${replica.name} in ${source} stopped (${status}).`;
      const hint = final
        ? "Inspect the delivered timeline and check its result. Close its tab with delete after checking it."
        : status === "waiting"
          ? "It waits for the user's answer to a question in its tab, and writes to it are refused until the user answers. Check that the question is one only the user can answer; then end your turn without a message. You hear again when it stops after the answer."
          : "Inspect the delivered timeline and determine why it stopped. If its work is finished, check the result and close it with delete. If it needs input, answer its question or steer it with write. When nothing significant happened and it keeps working, stay silent: end your turn without a message.";
      this.deliver(
        replica,
        owner,
        signal,
        await this.waiter.report(observations, cwd, { head, hint }),
        { signature: current, status, final },
      );
      if (final) return;
      after = current;
    }
  }

  /** Wait until the replica answers an inspection; returns its listed address, or undefined after reporting why not. */
  private async start(
    replica: Replica,
    signal: AbortSignal,
    owner: string,
  ): Promise<string | undefined> {
    const source = `herdr:${replica.terminal}`,
      service = this.waiter.service;
    // After a reload the Herdr bridge may need a moment; a replica missing from a successful list is gone.
    const deadline =
      Date.now() + (replica.restored ? this.limits.restoreMs : this.limits.startupMs);
    let lastError: unknown;
    for (;;) {
      let agent: Agent | undefined;
      try {
        agent = (await service.list()).find((item) =>
          sameTerminal(item.terminal, replica.terminal),
        );
        if (!agent && replica.restored) {
          lastError = undefined;
          break;
        }
        if (agent && agentStatusOf(agent) !== "exited") {
          const value = await service.inspect(source);
          if (owner === this.owner()) service.cursors.pin(owner, value);
          // The inherited timeline is not a stop; anything the replica did after the copy is, even if it already finished.
          if (
            replica.after === undefined &&
            replica.since !== undefined &&
            !begun(value, replica.since)
          )
            replica.after = signature([
              { target: { source, terminal: replica.terminal, listed: agent.terminal }, value },
            ]);
          return agent.terminal;
        }
      } catch (error) {
        if (signal.aborted) return undefined;
        lastError = error;
      }
      if (agent && agentStatusOf(agent) === "exited") {
        this.deliver(
          replica,
          owner,
          signal,
          replica.restored
            ? `${titleOf(replica.kind)} ${replica.name} in ${source} exited. It no longer runs. Close its tab with delete when you no longer need it.`
            : `${titleOf(replica.kind)} ${replica.name} in ${source} exited before it started working. Read its tab in Herdr for the error, and close it with delete.`,
          { status: "exited", final: true },
        );
        return undefined;
      }
      if (Date.now() >= deadline) break;
      await sleep(this.waiter.timing.pollMs, signal).catch(() => {});
      if (signal.aborted) return undefined;
    }
    const why = lastError ? ` Last error: ${oneLine(messageOf(lastError)).slice(0, 300)}` : "";
    this.deliver(
      replica,
      owner,
      signal,
      replica.restored
        ? `${titleOf(replica.kind)} ${replica.name} in ${source} is no longer running.${why}`
        : `${titleOf(replica.kind)} ${replica.name} in ${source} did not start answering within ${Math.round(this.limits.startupMs / 1000)} seconds.${why} Look at its tab in Herdr; close it with delete if it failed.`,
      { status: "exited", final: true },
    );
    return undefined;
  }
}

/** Register the replicate tool and the delivery of replica stops. */
export function registerReplicate(
  pi: ExtensionAPI,
  waiter: AgentWaiter,
  owner: () => string,
  limits?: { startupMs: number; restoreMs: number },
): ReplicaWatcher {
  const watcher = new ReplicaWatcher(pi, waiter, owner, limits);
  pi.on("session_start", (_event, ctx) => watcher.restore(ctx));
  pi.on("session_tree", (_event, ctx) => watcher.restore(ctx));
  pi.on("session_shutdown", () => watcher.stopAll());
  pi.events.on("herdr:recovery-persisted", (event: unknown) => {
    const ctx = record(event)?.ctx as ExtensionContext | undefined;
    if (ctx) watcher.reconcile(ctx);
  });
  pi.registerMessageRenderer<ReplicaMessageDetails>(REPLICA_MESSAGE, (message, options, theme) => {
    const details = message.details;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    const failed = details?.status === "failed";
    const kind = titleOf(details?.kind);
    const title = failed
      ? theme.fg("error", `${kind} watch failed`)
      : theme.fg("toolTitle", theme.bold(`${kind} ${details?.final ? "exited" : "stopped"}`));
    const who = details
      ? `${oneLine(details.name)} · herdr:${oneLine(details.terminal)}${details.final || failed ? "" : ` · ${details.status}`}`
      : "";
    return new Text(
      options.expanded ? `${title} · ${who}\n${text}` : `${title} · ${theme.fg("muted", who)}`,
      1,
      0,
    );
  });
  pi.registerTool({
    name: "replicate",
    label: "Replicate",
    description:
      "Use replicate to run a substantial, self-contained block of your task in parallel with a copy of yourself in a new Herdr tab while you work on a different block. Each time the copy stops, its timeline arrives here as a message until you close it.",
    promptSnippet:
      "Run a self-contained block of your task in parallel with a copy of yourself while you work on a different block.",
    promptGuidelines: [
      "Use replicate for a part of your own task that needs your context: the copy knows everything you know. For side work that does not need your context, such as research, a search or an isolated task, use subagent instead.",
      "Use replicate only from a task-ready state: you are already in the intended working location and understand the task. Do not replicate while still deciding the task, its scope, or where to work.",
      "Replicate a substantial, self-contained block: one you would otherwise do as a separate step and that needs no result from another block. Do small changes yourself.",
      "Replicas work in your directory at the same time. Give each replica that changes files its own area, such as a module or a set of files, and name it in the task. Read-only work, such as a review of your changes, needs no separate area.",
      "Before calling replicate, know what the replica must do, what result you expect back, and which different block you will work on yourself. If your next action after launching a replica would be to wait for it, do the work yourself instead.",
      "Each time a replica stops, its timeline arrives as a message. Answer its question or steer it with write to its herdr: address, and close it with delete once its work is done and checked. When nothing significant happened and the replica keeps working, stay silent: end your turn without a message. Do not poll; after finishing your own block, end your turn.",
      "Do not commit while replicas run. After they finish, check the combined result and commit it yourself.",
      "If you are a replica, complete only your assignment and follow its rules, then stop with a final message: what you did, the files you changed, and what is left or failed.",
    ],
    parameters: Type.Object(
      {
        name: Type.String({
          pattern: namePattern.source,
          description:
            "A task-specific name in lowercase kebab-case, such as check-auth-risks. It names the replica's tab.",
        }),
        task: Type.String({
          minLength: 1,
          description:
            "The exact work the replica must complete, the files or modules it may change, and the result you expect back.",
        }),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("replicate"))} ${theme.fg("muted", oneLine(args.name))}`,
        0,
        0,
      );
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!namePattern.test(params.name))
        throw failure(
          "HERDR_INVALID_NAME",
          "herdr:",
          "Name the replica in lowercase kebab-case, such as check-auth-risks.",
        );
      if (!params.task.trim())
        throw failure("HERDR_INVALID_TASK", "herdr:", "Describe the replica's task.");
      const manager = ctx.sessionManager;
      const parentFile = manager.getSessionFile();
      if (!parentFile)
        throw failure(
          "HERDR_REPLICATE_UNSAVED",
          "herdr:",
          "This session is not saved, so it cannot be copied. Start Pi with a saved session to replicate.",
        );
      if (!ctx.model)
        throw failure("HERDR_REPLICATE_NO_MODEL", "herdr:", "Select a model before replicating.");
      // Capture the conversation before any await, so a later turn cannot change the copy.
      const since = Date.now();
      const entries: ForkEntry[] = manager.getBranch().map((entry) => ({ ...entry }));
      // Pi's projected context, after compaction and context edits, tells which tool calls are still open.
      const messages: ForkMessage[] = manager
        .buildSessionProjection()
        .messages.map((message) => ({ ...message }));
      const fork = await writeReplicaSession({
        parentFile,
        sessionDir: manager.getSessionDir(),
        cwd: ctx.cwd,
        name: params.name,
        entries,
        messages,
        callId: toolCallId,
        answer: `You are the replica "${params.name}" that this call created. Your assignment is the next message.`,
      });
      const thinking = pi.getThinkingLevel();
      let launched: { terminal?: unknown; space?: unknown; tab?: unknown };
      const receipts: RecoveryReceipt[] = [];
      try {
        launched = await waiter.service.command(
          "agent.replicate",
          {
            name: params.name,
            session: fork.file,
            folder: ctx.cwd,
            model: `${ctx.model.provider}/${ctx.model.id}`,
            thinking,
            task: replicaAssignment(params.name, params.task),
          },
          "herdr:",
          toolCallId,
          receipts,
        );
      } catch (error) {
        const reason = messageOf(error);
        const refused =
          error instanceof ResourceError
            ? error.effect === "not-applied"
            : /Unsupported Herdr bridge command|^agent\.replicate /u.test(reason);
        // Nothing started, so the prepared copy is not needed.
        if (refused) await rm(fork.file, { force: true });
        if (error instanceof ResourceError) throw error;
        if (/Unsupported Herdr bridge command/iu.test(reason))
          throw failure(
            "HERDR_REPLICATE_UNSUPPORTED",
            "herdr:",
            "Update Herdr App, then reload Pi to replicate.",
          );
        if (refused && NESTING_LIMIT.test(reason))
          throw failure("HERDR_NESTING_LIMIT", "herdr:", reason);
        if (refused) throw failure("HERDR_REPLICATE_REFUSED", "herdr:", reason);
        // The App may have opened the tab before the reply was lost.
        throw failure(
          "HERDR_REPLICATE_FAILED",
          "herdr:",
          `${reason}. Read herdr: before replicating again: the replica may be running.`,
          "unknown",
        );
      }
      if (typeof launched.terminal !== "string" || !launched.terminal)
        throw failure(
          "HERDR_INVALID_REPLY",
          "herdr:",
          "Herdr did not return the replica's terminal. Read herdr: before replicating again.",
          "unknown",
        );
      const details: ReplicaDetails = {
        terminal: launched.terminal,
        name: params.name,
        owner: owner(),
        since,
        kind: "replica",
        session: fork.id,
        herdrReceipts: receipts,
        ...(typeof launched.space === "string" ? { space: launched.space } : {}),
        ...(typeof launched.tab === "string" ? { tab: launched.tab } : {}),
      };
      watcher.follow(
        { terminal: details.terminal, name: details.name, since, restored: false },
        ctx.cwd,
      );
      const source = `herdr:${details.terminal}`;
      return {
        content: [
          {
            type: "text",
            text: `Replica ${params.name} started in ${source}, a new tab in your space, working in ${ctx.cwd}. Each time it stops, its timeline arrives here as a message. Steer it with write to ${source}; close it with delete once its work is done and checked.`,
          },
        ],
        details,
      };
    },
  });
  return watcher;
}
