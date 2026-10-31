export type SemanticEngine = "colgrep" | "vera";

/** Resolve the configured engine without silently falling back on invalid settings. */
export function semanticEngine(value: string | undefined): SemanticEngine {
  if (value === undefined || value === "colgrep") return "colgrep";
  if (value === "vera") return "vera";
  throw new Error(`Unknown semantic search engine: ${value}`);
}
