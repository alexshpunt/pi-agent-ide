import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ResourceError } from "pi-agent-ide/api/resource";
import { address, failure, sameTerminal, type Agent, type HerdrService } from "./service.ts";
import { agentStatusOf, oneLine, replyHashOf, statusOf, type Inspection } from "./timeline.ts";

export const WAIT_MESSAGE = "herdr-agents-wait";
const MAX_AGENTS = 20;
/** Smallest share of the read budget one agent gets, so a long list still shows each latest reply. */
const MIN_AGENT_BUDGET = 500;
const PAUSE_HINT =
  "An agent also stops to compact, teleport or reload Pi. If an agent's timeline shows such a pause rather than finished work, call wait_for_agents again for it.";

export interface WaitTiming {
  pollMs: number;
  sendGraceMs: number;
  maxFailures: number;
}
const defaultTiming: WaitTiming = { pollMs: 2000, sendGraceMs: 30000, maxFailures: 15 };

export interface Target {
  source: string;
  terminal: string;
  listed: string;
}
export type Observation = { target: Target; value?: Inspection; error?: unknown };
export interface WaitDetails {
  requestId: string;
  agents: string[];
  status: "waiting" | "stopped" | "failed";
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const whenStopped = (sources: string[]) =>
  sources.length === 1 ? "the agent stops" : "all of them stop";
export const signature = (observations: Observation[]) =>
  JSON.stringify(
    observations.map(({ target, value }) =>
      value
        ? [
            target.terminal,
            statusOf(value),
            value.pid,
            value.session,
            replyHashOf(value) ?? "",
            value.inspection.events.length,
          ]
        : [target.terminal, "gone"],
    ),
  );
export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });

/** Match a herdr: address to exactly one listed agent; a bare terminal matches on any one machine. */
function locate(source: string, terminal: string, agents: Agent[]): string {
  const matches = agents.filter((agent) => sameTerminal(agent.terminal, terminal));
  if (matches.length === 1) return matches[0].terminal;
  if (matches.length > 1)
    throw failure(
      "HERDR_AMBIGUOUS_ADDRESS",
      source,
      `${source} matches ${matches.map((agent) => `herdr:${agent.terminal}`).join(", ")}. Use the full address.`,
    );
  throw failure(
    "HERDR_UNKNOWN_AGENT",
    source,
    `No Pi agent at ${source}. Read herdr: for the current addresses.`,
  );
}

/** Polls Herdr until every target stops, then renders their timelines as one read. */
export class AgentWaiter {
  constructor(
    readonly service: HerdrService,
    private budget: (cwd: string) => Promise<number>,
    readonly timing: WaitTiming = defaultTiming,
  ) {}

  async resolve(sources: string[]): Promise<Target[]> {
    const unique = [...new Set(sources)];
    if (!unique.length || unique.length > MAX_AGENTS)
      throw failure(
        "HERDR_INVALID_TARGETS",
        "herdr:",
        `Supply from 1 to ${MAX_AGENTS} agent addresses.`,
      );
    const parsed = unique.map((source) => {
      const target = source === "herdr:" ? undefined : address(source);
      if (!target || target.history)
        throw failure(
          "HERDR_INVALID_ADDRESS",
          source,
          "Wait for an agent address such as herdr:workstation/t7. Read herdr: for the list.",
        );
      return { source, terminal: target.terminal };
    });
    const agents = await this.service.list();
    return parsed.map((target) => ({
      ...target,
      listed: locate(target.source, target.terminal, agents),
    }));
  }

  /** Wait until every target stops; cwd selects the read-budget setting for the result. */
  async run(targets: Target[], signal: AbortSignal, cwd: string): Promise<string> {
    return this.report((await this.settle(targets, signal)).observations, cwd);
  }

  /** Wait until every target stops in a state other than `after`, a signature an earlier settle returned. */
  async settle(
    targets: Target[],
    signal: AbortSignal,
    after?: string,
  ): Promise<{ observations: Observation[]; signature: string }> {
    let failures = 0;
    // A reloading Pi looks idle for a moment; only a stopped state seen on two polls in a row ends the wait.
    let previous: string | undefined;
    for (;;) {
      signal.throwIfAborted();
      try {
        const observations = await this.observe(targets);
        failures = 0;
        const current = observations && signature(observations);
        if (observations && current && current === previous && current !== after)
          return { observations, signature: current };
        previous = current;
      } catch (error) {
        previous = undefined;
        signal.throwIfAborted();
        if (error instanceof ResourceError && error.code === "HERDR_UNAVAILABLE") throw error;
        if (++failures >= this.timing.maxFailures)
          throw failure(
            "HERDR_WAIT_FAILED",
            targets[0].source,
            `Herdr did not answer for ${Math.round((failures * this.timing.pollMs) / 1000)} seconds: ${messageOf(error)}`,
          );
      }
      await sleep(this.timing.pollMs, signal);
    }
  }

  /** Returns observations once every target has stopped, or undefined while any still works. */
  private async observe(targets: Target[]): Promise<Observation[] | undefined> {
    const listed = new Map((await this.service.list()).map((agent) => [agent.terminal, agent]));
    let working = false;
    for (const target of targets) {
      const agent = listed.get(target.listed);
      if (agent && agentStatusOf(agent) === "working") {
        this.service.acknowledge(target.terminal);
        working = true;
      }
    }
    if (working) return undefined;
    const observations = await Promise.all(
      targets.map(async (target): Promise<Observation> => {
        const agent = listed.get(target.listed);
        try {
          return { target, value: await this.service.inspect(target.source) };
        } catch (error) {
          // A live listed agent must answer; a vanished or exited one is reported as exited.
          if (agent && agentStatusOf(agent) !== "exited") throw error;
          return { target, error };
        }
      }),
    );
    for (const { target, value } of observations) {
      if (!value) continue;
      const status = statusOf(value);
      if (status === "working") {
        this.service.acknowledge(target.terminal);
        return undefined;
      }
      if (
        (status === "idle" || status === "error") &&
        this.service.sendPending(value, this.timing.sendGraceMs)
      )
        return undefined;
    }
    return observations;
  }

  /** Render stopped observations as one read; `head` replaces the default first line. */
  async report(
    observations: Observation[],
    cwd: string,
    framing?: { head: string; hint: string },
  ): Promise<string> {
    const budget = Math.max(
      MIN_AGENT_BUDGET,
      Math.floor((await this.budget(cwd)) / observations.length),
    );
    const sections = observations.map(
      ({ target, value, error }) =>
        `${target.source}\n${
          value
            ? this.service.render(value, budget)
            : `status: exited\nerror: ${oneLine(messageOf(error)).slice(0, 300)}`
        }`,
    );
    const head =
      framing?.head ??
      (observations.length === 1
        ? `${observations[0].target.source} stopped.`
        : `All ${observations.length} agents stopped.`);
    return [head, ...sections, framing?.hint ?? PAUSE_HINT].join("\n\n");
  }
}

interface ActiveWait {
  controller: AbortController;
  sources: string[];
  release?: () => void;
}

/** Register wait_for_agents with foreground waits that a new message moves to the background. */
export function registerWaitForAgents(pi: ExtensionAPI, waiter: AgentWaiter): void {
  const waits = new Map<string, ActiveWait>();
  let context: ExtensionContext | undefined;
  const updateStatus = () => {
    const background = [...waits.values()].filter((wait) => !wait.release).length;
    context?.ui.setStatus(
      "herdr-wait",
      background ? `Waiting for Herdr agents (${background})` : undefined,
    );
  };
  const cancelAll = () => {
    for (const wait of waits.values())
      wait.controller.abort(new DOMException("Herdr agent wait cancelled", "AbortError"));
    waits.clear();
    updateStatus();
  };
  pi.on("session_start", (_event, ctx) => {
    cancelAll();
    context = ctx;
  });
  pi.on("session_tree", (_event, ctx) => {
    cancelAll();
    context = ctx;
  });
  pi.on("session_shutdown", () => {
    cancelAll();
    context = undefined;
  });
  // A message that arrives during a foreground wait would otherwise sit queued until the agents stop.
  pi.on("input", (event) => {
    if (!event.streamingBehavior) return;
    for (const wait of waits.values()) wait.release?.();
  });
  pi.registerMessageRenderer<WaitDetails>(WAIT_MESSAGE, (message, options, theme) => {
    const details = message.details;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    const title =
      details?.status === "failed"
        ? theme.fg("error", "Herdr agent wait failed")
        : theme.fg("toolTitle", theme.bold("Herdr agents stopped"));
    const agents = details?.agents.join(", ") ?? "";
    return new Text(
      options.expanded
        ? `${title} · ${agents}\n${text}`
        : `${title} · ${theme.fg("muted", agents)}`,
      1,
      0,
    );
  });

  const receipt = (requestId: string, sources: string[], text: string) => ({
    content: [{ type: "text" as const, text }],
    details: { requestId, agents: sources, status: "waiting" } satisfies WaitDetails,
  });
  pi.registerTool({
    name: "wait_for_agents",
    label: "Wait for agents",
    exposure: "deferred",
    executionMode: "parallel",
    namespace: { name: "Herdr", description: "Manage the user’s independent agents in Herdr App" },
    description:
      "Use wait_for_agents to wait until the Herdr agents you coordinate stop working, then get each agent's status and latest timeline in one result. Call it after starting or messaging agents when you need their results.",
    promptSnippet: "Wait until Herdr agents stop working.",
    parameters: Type.Object(
      {
        path: Type.Union(
          [
            Type.String({ minLength: 1 }),
            Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_AGENTS }),
          ],
          {
            description:
              "Agent address, such as herdr:workstation/t7, or a list of addresses. Read herdr: for the list. The wait ends when every listed agent is idle, waiting for the user, in error or exited.",
          },
        ),
        background: Type.Optional(
          Type.Boolean({
            description:
              "Set true to return at once and receive the result later as a message while you do other work or end your turn. By default the call waits; a new message to you moves it to the background.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    renderCall(args, theme) {
      const paths = Array.isArray(args.path) ? args.path : args.path ? [args.path] : [];
      return new Text(
        `${theme.fg("toolTitle", theme.bold("wait_for_agents"))} ${theme.fg("muted", paths.map((path) => oneLine(String(path))).join(", "))}${args.background ? theme.fg("muted", " · background") : ""}`,
        0,
        0,
      );
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      context = ctx;
      const sources = [...new Set(Array.isArray(params.path) ? params.path : [params.path])];
      const targets = await waiter.resolve(sources);
      const wait: ActiveWait = { controller: new AbortController(), sources };
      waits.set(toolCallId, wait);
      const outcome = waiter.run(targets, wait.controller.signal, ctx.cwd).then(
        (text) => ({ text, failed: false }),
        (error) =>
          wait.controller.signal.aborted ? undefined : { text: messageOf(error), failed: true },
      );
      const deliverLater = () => {
        updateStatus();
        void outcome.then((result) => {
          if (waits.get(toolCallId) !== wait) return;
          waits.delete(toolCallId);
          updateStatus();
          if (!result) return;
          const details: WaitDetails = {
            requestId: toolCallId,
            agents: sources,
            status: result.failed ? "failed" : "stopped",
          };
          pi.sendMessage(
            {
              customType: WAIT_MESSAGE,
              content: result.failed
                ? `wait_for_agents failed for ${sources.join(", ")}: ${result.text}`
                : result.text,
              display: true,
              details,
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        });
      };
      if (params.background) {
        deliverLater();
        return receipt(
          toolCallId,
          sources,
          `Waiting for ${sources.join(", ")} in the background. The result arrives as a message when ${whenStopped(sources)}.`,
        );
      }
      const released = new Promise<"released">((resolve) => {
        wait.release = () => resolve("released");
      });
      const abort = () => wait.controller.abort(signal?.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await Promise.race([outcome, released]);
        if (result === "released") {
          wait.release = undefined;
          deliverLater();
          return receipt(
            toolCallId,
            sources,
            `A new message arrived, so the wait for ${sources.join(", ")} continues in the background. Its result arrives as a message when ${whenStopped(sources)}.`,
          );
        }
        waits.delete(toolCallId);
        if (!result)
          throw signal?.reason ?? new DOMException("Herdr agent wait cancelled", "AbortError");
        if (result.failed) throw new Error(result.text);
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            requestId: toolCallId,
            agents: sources,
            status: "stopped",
          } satisfies WaitDetails,
        };
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  });
}
