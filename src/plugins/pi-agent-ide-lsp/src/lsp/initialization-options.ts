/** Expand the project path in JSON initialization options, including plugin locations. */
export function resolveInitializationOptions(
  value: Record<string, unknown>,
  projectRoot: string,
): Record<string, unknown> {
  const expand = (item: unknown): unknown => {
    if (typeof item === "string") return item.replaceAll("{project}", () => projectRoot);
    if (Array.isArray(item)) return item.map(expand);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, expand(child)]));
    return item;
  };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
}
