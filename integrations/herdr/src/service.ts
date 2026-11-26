import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ResourceError } from "pi-agent-ide/api/resource";
import {
  ReadCursor,
  agentStatusOf,
  clean,
  oneLine,
  renderTimeline,
  replyHashOf,
  type Inspection,
} from "./timeline.ts";

export interface Bridge {
  version: 1;
  command(name: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface HistoryItem {
  index: number;
  at: string;
  kind: string;
  tool?: string;
  text: string;
}
export interface Agent {
  terminal: string;
  name?: string;
  status?: string;
  state?: string;
  exited?: boolean;
}
export function agentLine(agent: Agent): string {
  return `${agent.terminal} · ${oneLine(agent.name || agent.terminal)} · ${agentStatusOf(agent)}`;
}
export function failure(
  code: string,
  source: string,
  message: string,
  effect: "not-applied" | "unknown" = "not-applied",
): ResourceError {
  const error = new ResourceError(code, source, effect);
  error.message = `${code}: ${message}`;
  return error;
}
export function address(source: string): { terminal: string; history: boolean } | undefined {
  if (!source.startsWith("herdr:")) return undefined;
  if (source === PROFILES)
    throw failure(
      "UNSUPPORTED_OPERATION",
      source,
      "herdr:profiles only lists the workflow profiles: read it. The user changes them in Herdr App's Workflow settings.",
    );
  const match = /^herdr:((?:[^\s/:#]+\/)?t[a-zA-Z0-9]+)(\/history)?$/u.exec(source);
  if (!match)
    throw failure(
      "HERDR_INVALID_ADDRESS",
      source,
      "Read herdr: and use an exact displayed terminal address.",
    );
  return { terminal: match[1], history: !!match[2] };
}
/** The user's workflow profiles: which model and thinking level an agent of each kind of task gets. */
export const PROFILES = "herdr:profiles";
export interface Profile {
  id: string;
  name?: string;
  description?: string;
  model: string;
  fallbackModel?: string;
  thinking?: string;
}
export function profilesText(profiles: Profile[]): string {
  if (!profiles.length)
    return "No workflow profiles. The user adds them in Herdr App's Workflow settings.";
  return profiles
    .map((profile) => {
      const fallback = profile.fallbackModel ? ` · fallback ${oneLine(profile.fallbackModel)}` : "";
      const head = `${oneLine(profile.id)} · ${oneLine(profile.name || profile.id)} · ${oneLine(profile.model)} · thinking ${oneLine(profile.thinking ?? "high")}${fallback}`;
      return profile.description?.trim() ? `${head}\n  ${oneLine(profile.description)}` : head;
    })
    .join("\n");
}
/** True when a requested terminal names a listed one; a bare terminal matches it on any machine. */
export const sameTerminal = (listed: string, requested: string) =>
  listed === requested || (!requested.includes("/") && listed.endsWith(`/${requested}`));
/** App refusals that mean the agent's Pi or session differs from the last read. */
const staleIdentity = /PID or session changed|stale|identity.*changed|No current Pi identity/iu;
export class HerdrService {
  readonly cursors = new ReadCursor();
  private readonly sends = new Map<
    string,
    { at: number; pid: number; session: string; replyHash?: string }
  >();
  private readonly replicas = new Map<string, Set<string>>();
  constructor(
    private pi: Pick<ExtensionAPI, "events">,
    private owner: () => string,
  ) {}
  async command<T>(name: string, args: Record<string, unknown>, source: string): Promise<T> {
    let bridge: Bridge | undefined;
    this.pi.events.emit("herdr:bridge", {
      provide: (value: Bridge) => {
        bridge = value;
      },
    });
    if (!bridge || bridge.version !== 1)
      throw failure(
        "HERDR_UNAVAILABLE",
        source,
        "Run Pi in a Herdr terminal with a current Herdr App, then reload Pi.",
      );
    const result = await bridge.command(name, args);
    if (result && typeof result === "object" && "error" in result)
      throw new Error(String(result.error));
    return result as T;
  }
  async list(): Promise<Agent[]> {
    const result = await this.command<{ agents: Agent[] }>("agent.list", {}, "herdr:");
    if (!Array.isArray(result.agents))
      throw failure(
        "HERDR_INVALID_REPLY",
        "herdr:",
        "Herdr returned an invalid agent list. Update the App and reload Pi.",
      );
    return result.agents;
  }
  /** The user's workflow profiles, read fresh each time so added and removed ones show at once. */
  async profiles(): Promise<Profile[]> {
    const result = await this.command<{ profiles?: unknown }>("workflow.get", {}, PROFILES);
    if (
      !Array.isArray(result.profiles) ||
      !result.profiles.every(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          typeof item.model === "string",
      )
    )
      throw failure(
        "HERDR_INVALID_REPLY",
        PROFILES,
        "Herdr returned invalid workflow profiles. Update the App and reload Pi.",
      );
    return result.profiles as Profile[];
  }
  async read(source: string, budget: number): Promise<string> {
    if (source === "herdr:")
      return (await this.list()).map(agentLine).join("\n") || "No Pi agents in Herdr.";
    if (source === PROFILES) return profilesText(await this.profiles());
    return this.render(await this.inspect(source), budget);
  }
  async inspect(source: string): Promise<Inspection> {
    const target = address(source)!;
    const value = await this.command<Inspection>(
      "agent.inspect",
      { terminal: target.terminal },
      source,
    );
    if (
      !value.inspection ||
      !Array.isArray(value.inspection.events) ||
      typeof value.inspection.busy !== "boolean" ||
      typeof value.pid !== "number" ||
      typeof value.session !== "string" ||
      value.terminal !== target.terminal
    )
      throw failure(
        "HERDR_INVALID_REPLY",
        source,
        "Herdr returned an invalid timeline. Update the App and reload the target Pi.",
      );
    return value;
  }
  /** Render an inspection as a read: advances the reply cursor and authorizes a later send. */
  render(value: Inspection, budget: number): string {
    const owner = this.owner();
    const rendered = renderTimeline(value, budget, this.cursors.unchanged(owner, value));
    // Never let a completed read from a replaced owner authorize the new session.
    if (owner === this.owner()) this.cursors.record(owner, value);
    return rendered;
  }
  /** True while a message this session sent may not have reached the idle agent yet. */
  sendPending(value: Inspection, graceMs: number, now = Date.now()): boolean {
    const key = `${this.owner()}\0${value.terminal}`,
      sent = this.sends.get(key);
    if (!sent) return false;
    if (
      now - sent.at > graceMs ||
      sent.pid !== value.pid ||
      sent.session !== value.session ||
      replyHashOf(value) !== sent.replyHash
    ) {
      this.sends.delete(key);
      return false;
    }
    return true;
  }
  /** Replicas this session started; it may message and close them without reading them first. */
  adopt(terminal: string): void {
    const owner = this.owner();
    let terminals = this.replicas.get(owner);
    if (!terminals) this.replicas.set(owner, (terminals = new Set()));
    terminals.add(terminal);
  }
  /** The identity a write or delete is checked against: the last read, or a replica's current one. */
  private async identity(
    source: string,
    terminal: string,
  ): Promise<{ pid: number; session: string } | undefined> {
    const owner = this.owner(),
      known = this.cursors.identity(owner, terminal);
    if (
      known ||
      ![...(this.replicas.get(owner) ?? [])].some((replica) => sameTerminal(replica, terminal))
    )
      return known;
    let value: Inspection;
    try {
      value = await this.inspect(source);
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      throw failure(
        "HERDR_REPLICA_STARTING",
        source,
        `The replica in ${terminal} does not answer yet; it may still be starting. Try again shortly.`,
      );
    }
    if (owner === this.owner()) this.cursors.pin(owner, value);
    return this.cursors.identity(owner, terminal);
  }
  /** Forget a recorded send once the agent was seen working on it. */
  acknowledge(terminal: string): void {
    this.sends.delete(`${this.owner()}\0${terminal}`);
  }
  async history(source: string, params: Record<string, unknown>): Promise<HistoryItem[]> {
    const target = address(source)!;
    const result = await this.command<{ items?: HistoryItem[]; matches?: HistoryItem[] }>(
      "agent.history",
      { terminal: target.terminal, ...params },
      source,
    );
    const items = params.query === undefined ? result.items : result.matches;
    if (!Array.isArray(items))
      throw failure("HERDR_INVALID_REPLY", source, "Herdr returned an invalid history page.");
    return items;
  }
  async send(source: string, message: string): Promise<void> {
    const target = address(source);
    if (!target || target.history)
      throw failure("UNSUPPORTED_OPERATION", source, "Write a message to herdr:<terminal>.");
    const owner = this.owner(),
      identity = await this.identity(source, target.terminal);
    if (!identity)
      throw failure(
        "HERDR_READ_FIRST",
        source,
        `Read ${source} in this session before sending a message.`,
      );
    if (!message.trim())
      throw failure("HERDR_INVALID_MESSAGE", source, "Supply a non-empty message.");
    try {
      await this.command("agent.send", { terminal: target.terminal, ...identity, message }, source);
      this.sends.set(`${owner}\0${target.terminal}`, {
        at: Date.now(),
        ...identity,
        replyHash: this.cursors.replyHash(owner, target.terminal),
      });
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (staleIdentity.test(reason))
        throw failure(
          "HERDR_STALE_TARGET",
          source,
          `The agent in ${target.terminal} changed since your last read; read it again.`,
        );
      // App and IPC precondition refusals happen before delivery. Other transport failures may have applied.
      const refused =
        /waiting for the user|blocked|still starting|startup|before acting|cannot send.*self/iu.test(
          reason,
        );
      throw failure(
        refused ? "HERDR_SEND_REFUSED" : "HERDR_SEND_FAILED",
        source,
        reason,
        refused ? "not-applied" : "unknown",
      );
    }
  }
  /** End the agent read in this session and close its dedicated tab through Herdr's agent.remove. */
  async remove(source: string): Promise<void> {
    const target = address(source);
    if (!target || target.history)
      throw failure("UNSUPPORTED_OPERATION", source, "Delete herdr:<terminal> to close an agent.");
    const owner = this.owner(),
      identity = await this.identity(source, target.terminal);
    if (!identity)
      throw failure(
        "HERDR_READ_FIRST",
        source,
        `Read ${source} in this session before closing it.`,
      );
    try {
      await this.command("agent.remove", { terminal: target.terminal, ...identity }, source);
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      // Agents see only the code, so each refusal the App makes before ending the terminal gets its own.
      if (staleIdentity.test(reason))
        throw failure(
          "HERDR_STALE_TARGET",
          source,
          `The agent in ${target.terminal} changed since your last read; read it again.`,
        );
      if (/calling Pi/iu.test(reason))
        throw failure("HERDR_DELETE_SELF", source, "Do not close your own terminal.");
      if (/single-pane tab/iu.test(reason)) throw failure("HERDR_DELETE_SPLIT_TAB", source, reason);
      // The App looks the terminal up before ending anything; a closed terminal fails here.
      if (/^Cannot inspect /u.test(reason))
        throw failure(
          "HERDR_UNKNOWN_AGENT",
          source,
          `No Pi agent at ${source}. Read herdr: for the current agents.`,
        );
      // An App older than this feature refuses the command in the bridge, before reaching Herdr.
      if (/Unsupported Herdr bridge command/iu.test(reason))
        throw failure(
          "HERDR_DELETE_UNSUPPORTED",
          source,
          "Update Herdr App, then reload Pi to close agents.",
        );
      // A failure after the App started ending the terminal may have closed the agent already.
      throw failure("HERDR_DELETE_FAILED", source, reason, "unknown");
    }
    this.cursors.forget(owner, target.terminal);
    this.sends.delete(`${owner}\0${target.terminal}`);
    const replicas = this.replicas.get(owner);
    for (const replica of replicas ?? [])
      if (sameTerminal(replica, target.terminal)) replicas!.delete(replica);
  }
}
export function historyText(items: HistoryItem[]): string {
  return items
    .map(
      (item) =>
        `${item.index + 1}: ${oneLine(item.at)} ${oneLine(item.kind)}${item.tool ? ` ${oneLine(item.tool)}` : ""}: ${oneLine(clean(item.text))}`,
    )
    .join("\n");
}
