export interface UnityTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

export function catalogAddress(project: string, name?: string): string {
  const base = `unity://project/${encodeURIComponent(project)}/tools`;
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

export function parseCatalogAddress(
  source: string,
): { project: string; name?: string } | undefined {
  const match = /^unity:\/\/project\/([^/]+)\/tools(?:\/([^/]+))?$/.exec(source);
  if (!match) return undefined;
  const project = decodeURIComponent(match[1]);
  const encodedName = match.at(2);
  const name = encodedName === undefined ? undefined : decodeURIComponent(encodedName);
  if (!project || name === "") throw new Error("Invalid Unity tool resource.");
  return { project, name };
}

export function readCatalogTool(tools: readonly UnityTool[], name: string): UnityTool {
  const found = tools.filter((tool) => tool.name === name);
  if (found.length !== 1)
    throw new Error(`Expected one Unity tool named ${name}; found ${found.length}.`);
  return found[0];
}

export function searchCatalog(
  project: string,
  tools: readonly UnityTool[],
  query: string,
  limit: number,
) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  if (!terms.length || query.length > 4096)
    throw new Error("Provide a non-empty search query of at most 4096 characters.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Search limit must be between 1 and 100.");
  const matches = tools.filter((tool) => {
    const text =
      `${tool.name.replaceAll("_", " ")} ${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
  return {
    items: matches.slice(0, limit).map((tool) => ({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(tool.description === undefined ? {} : { description: tool.description }),
      uri: catalogAddress(project, tool.name),
    })),
    complete: matches.length <= limit,
  };
}
