import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DOCUMENTATION_PROTOCOL = "pi-agent-ide-documentation" as const;
export const DOCUMENTATION_API_VERSION = 1 as const;
export const DOCUMENTATION_READY_EVENT = `${DOCUMENTATION_PROTOCOL}/core/ready` as const;
export const DOCUMENTATION_REGISTER_EVENT = `${DOCUMENTATION_PROTOCOL}/document/register` as const;

/** One tool-call shape that makes a packaged guide relevant. */
export interface AgentDocumentationTrigger {
  readonly tool: string;
  /** Restrict path-bearing calls to these resource prefixes. Omit for every path. */
  readonly resourcePrefixes?: readonly string[];
  /** Restrict calls to views with one of these prefixes. Omit for every view. */
  readonly viewPrefixes?: readonly string[];
}

/** A packaged guide that can be discovered, read explicitly, and attached on first relevant use. */
export interface AgentDocumentation {
  readonly id: string;
  readonly description: string;
  readonly markdown: string;
  readonly triggers: readonly AgentDocumentationTrigger[];
}

/** Loads one Markdown guide shipped with the documentation protocol package. */
export async function loadPackagedAgentGuide(
  definition: Omit<AgentDocumentation, "markdown">,
): Promise<AgentDocumentation> {
  return {
    ...definition,
    markdown: await readFile(
      path.join(await findHostPackageRoot(), "docs", "agent-guides", `${definition.id}.md`),
      "utf8",
    ),
  };
}

async function findHostPackageRoot(): Promise<string> {
  let current = import.meta.dirname;
  for (;;) {
    const manifest = path.join(current, "package.json");
    try {
      const parsed = JSON.parse(await readFile(manifest, "utf8")) as { readonly name?: unknown };
      if (parsed.name === "pi-agent-ide") return current;
    } catch {
      // Continue to the parent when this directory has no readable package manifest.
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Cannot locate the pi-agent-ide package root");
    current = parent;
  }
}

/** Registers packaged agent documentation without depending on documentation-core load order. */
export function connectAgentDocumentation(
  pi: ExtensionAPI,
  documents: readonly AgentDocumentation[],
): void {
  const announce = (): void => pi.events.emit(DOCUMENTATION_REGISTER_EVENT, { documents });
  let unsubscribe = pi.events.on(DOCUMENTATION_READY_EVENT, () => {
    announce();
    unsubscribe();
  });
  pi.on("session_shutdown", unsubscribe);
  announce();
}
