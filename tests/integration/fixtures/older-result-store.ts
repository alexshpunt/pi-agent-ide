import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Stand-in for an extension that bundles an older copy of the IDE SDK and loads before the IDE.
 * Like SDK 0.9.8, it creates the shared result store on the event bus at load time; its store
 * has no version and no `resolveCurrent`.
 */
export default function olderResultStore(pi: ExtensionAPI): void {
  const event = "pi-agent-resource:result-targets";
  let existing: unknown;
  pi.events.emit(event, {
    accept: (store: unknown) => {
      existing = store;
    },
  });
  if (existing !== undefined) return;
  const entries = new Map<string, unknown>();
  const store = {
    register: (targets: unknown, _cwd: string, complete = true): string => {
      const reference = `RESULT#older-${String(entries.size)}`;
      entries.set(reference, { targets, complete });
      return reference;
    },
    resolve: (input: unknown): unknown => {
      const entry = typeof input === "string" ? entries.get(input) : undefined;
      if (entry === undefined) throw new Error("Unsupported result input.");
      return entry;
    },
    source: (input: unknown): unknown => input,
    publish: (_outcome: unknown, text: string): string => text,
    invalidate: (): void => {},
    refresh: (): void => {},
    clear: (): void => {
      entries.clear();
    },
  };
  pi.events.on(event, (request) => {
    (request as { accept: (value: unknown) => void }).accept(store);
  });
}
