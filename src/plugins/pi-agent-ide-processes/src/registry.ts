import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export type AgentIdeProcessStatus = "configured" | "running" | "stopping" | "paused";

/** One active process contributed by an Agent IDE capability. */
export interface AgentIdeProcess {
  readonly source: string;
  readonly kind: string;
  readonly title: string;
  readonly description: string;
  readonly status: AgentIdeProcessStatus;
  /** Controller-native process ID. Use remote for processes on another target. */
  readonly pid?: number;
  /** Remote native PID and target identity. Never expose this PID as a controller process. */
  readonly remote?: {
    readonly target: string;
    readonly pid: number;
    /** Kernel lifetime captured by the owned channel; absent when the target cannot provide it. */
    readonly identity?: string;
  };
  /** True only when Agent IDE created and controls this process. */
  readonly owned?: boolean;
  /** Pi session that started this process; omitted when unknown. */
  readonly sessionId?: string;
  renderSummary(theme: Theme): readonly string[];
  renderDetail(theme: Theme): Component;
  stop(): Promise<void>;
  /** Forward raw keyboard input when this process has an interactive terminal. */
  sendInput?(data: string): void;
}

/** Supplies one process kind to the shared Agent IDE process surface. */
export interface AgentIdeProcessProvider {
  readonly id: string;
  /** One sentence the agent reads after compaction, such as how to list finished processes. */
  readonly compactionGuidance?: string;
  list(): readonly AgentIdeProcess[];
  onDidChange(listener: () => void): () => void;
}

type Listener = () => void;

/** Session-local registry shared by independently loaded Agent IDE extensions. */
export class AgentIdeProcessRegistry {
  readonly #providers = new Map<string, AgentIdeProcessProvider>();
  readonly #listeners = new Set<Listener>();
  readonly #disposeProviders = new Map<string, () => void>();

  add(provider: AgentIdeProcessProvider): () => void {
    this.#disposeProviders.get(provider.id)?.();
    this.#providers.set(provider.id, provider);
    this.#disposeProviders.set(
      provider.id,
      provider.onDidChange(() => this.#emit()),
    );
    this.#emit();
    return () => {
      if (this.#providers.get(provider.id) !== provider) return;
      this.#disposeProviders.get(provider.id)?.();
      this.#disposeProviders.delete(provider.id);
      this.#providers.delete(provider.id);
      this.#emit();
    };
  }

  list(): readonly AgentIdeProcess[] {
    return [...this.#providers.values()].flatMap((provider) => provider.list());
  }

  /**
   * Describe the processes of one Pi session for the agent after compaction has removed the
   * results that named them. Returns undefined when that session has no active process.
   */
  compactionNotice(sessionId: string | undefined): string | undefined {
    const lines: string[] = [];
    const guidance: string[] = [];
    for (const provider of this.#providers.values()) {
      const processes = provider
        .list()
        .filter((process) => process.sessionId === undefined || process.sessionId === sessionId);
      if (processes.length === 0) continue;
      lines.push(
        ...processes.map((process) =>
          [
            process.source,
            process.kind,
            process.status,
            process.title,
            oneLine(process.description),
          ]
            .filter((part) => part.length > 0)
            .join(" · "),
        ),
      );
      if (provider.compactionGuidance !== undefined) guidance.push(provider.compactionGuidance);
    }
    if (lines.length === 0) return undefined;
    return [
      "Agent IDE processes still active after compaction:",
      ...lines.map((line) => `- ${line}`),
      "Read a source to inspect the process, then continue working with it.",
      ...guidance,
    ].join("\n");
  }

  onDidChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    for (const dispose of this.#disposeProviders.values()) dispose();
    this.#disposeProviders.clear();
    this.#providers.clear();
    this.#listeners.clear();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

const registries = new WeakMap<ExtensionAPI, AgentIdeProcessRegistry>();

/**
 * Return the shared process registry for this Pi extension runtime. The first call also lists the
 * active processes for the agent after each compaction, since compaction drops the tool results
 * that named them.
 */
export function agentIdeProcessRegistry(pi: ExtensionAPI): AgentIdeProcessRegistry {
  let registry = registries.get(pi);
  if (registry === undefined) {
    const created = new AgentIdeProcessRegistry();
    registry = created;
    registries.set(pi, created);
    pi.on("session_compact", (_event, context) => {
      const content = created.compactionNotice(context.sessionManager.getSessionId());
      if (content === undefined) return;
      pi.sendMessage(
        { customType: PROCESSES_AFTER_COMPACTION, content, display: false },
        { deliverAs: "steer" },
      );
    });
  }
  return registry;
}

/** Custom message type of the process list sent after compaction. */
export const PROCESSES_AFTER_COMPACTION = "agent-ide-processes-after-compaction";

function oneLine(value: string): string {
  const line = value.replaceAll(/\s+/gu, " ").trim();
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}
