import type { ReadPluginApi } from "pi-agent-ide/api/read";
import { isLineAnchor } from "pi-agent-ide/api/text";

export async function readFirstLineAnchor(
  api: ReadPluginApi | undefined,
  source: string,
  context: { cwd: string; signal?: AbortSignal },
): Promise<{ text: string; anchor: string }> {
  if (!api) throw new Error("Read API unavailable");
  const result = await api.read({ path: source, views: ["anchors"] }, context, "script");
  const line = result.script?.kind === "text" ? result.script.lines[0] : undefined;
  const anchor = line?.anchors?.find(isLineAnchor);
  if (result.isError || !line || !anchor) throw new Error("Read did not issue a first-line anchor");
  return { text: line.content, anchor };
}

/** The exact match target issued by Search. */
export function firstMatchTarget(details: unknown): string {
  if (details && typeof details === "object" && "payload" in details) {
    const payload = details.payload;
    if (payload && typeof payload === "object" && "selection" in payload) {
      const selection = payload.selection;
      if (selection && typeof selection === "object" && "matchTargets" in selection) {
        const targets = selection.matchTargets;
        if (Array.isArray(targets) && typeof targets[0] === "string") return targets[0];
      }
    }
  }
  throw new Error("Search did not issue an exact match target");
}
