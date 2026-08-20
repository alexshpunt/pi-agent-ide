import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ResolvedResourceReference {
  readonly source: string;
  readonly resolverId: string;
}

const lastResolvedResourceKey = Symbol.for("pi-agent-text-editor.last-resolved-resource");

type ResourceContextHost = ExtensionAPI & {
  [lastResolvedResourceKey]: ResolvedResourceReference | undefined;
};

export function rememberLastResolvedResource(pi: ExtensionAPI, details: unknown): void {
  if (!isRecord(details)) {
    return;
  }

  const source = details.source;
  const resolverId = details.resolvedBy;

  if (
    typeof source !== "string" ||
    source.length === 0 ||
    typeof resolverId !== "string" ||
    resolverId.length === 0
  ) {
    return;
  }

  (pi as ResourceContextHost)[lastResolvedResourceKey] = { source, resolverId };
}

export function getLastResolvedResource(pi: ExtensionAPI): ResolvedResourceReference | undefined {
  return (pi as ResourceContextHost)[lastResolvedResourceKey];
}

export function clearLastResolvedResource(pi: ExtensionAPI): void {
  (pi as ResourceContextHost)[lastResolvedResourceKey] = undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
