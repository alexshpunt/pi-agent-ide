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
  renderSummary(theme: Theme): readonly string[];
  renderDetail(theme: Theme): Component;
  stop(): Promise<void>;
  /** Forward raw keyboard input when this process has an interactive terminal. */
  sendInput?(data: string): void;
}

/** Supplies one process kind to the shared Agent IDE process surface. */
export interface AgentIdeProcessProvider {
  readonly id: string;
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

/** Return the shared process registry for this Pi extension runtime. */
export function agentIdeProcessRegistry(pi: ExtensionAPI): AgentIdeProcessRegistry {
  let registry = registries.get(pi);
  if (registry === undefined) {
    registry = new AgentIdeProcessRegistry();
    registries.set(pi, registry);
  }
  return registry;
}
