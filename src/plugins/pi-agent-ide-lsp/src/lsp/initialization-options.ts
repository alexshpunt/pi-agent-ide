import type path from "node:path";

const VUE_PLUGIN = "node_modules/@vue/typescript-plugin";
const DEFAULT_VUE_PLUGIN_LOCATION = `{project}/${VUE_PLUGIN}`;

export function usesWorkspaceVuePlugin(options: Record<string, unknown>): boolean {
  return (
    Array.isArray(options.plugins) &&
    options.plugins.some(
      (plugin: unknown) =>
        typeof plugin === "object" &&
        plugin !== null &&
        "location" in plugin &&
        plugin.location === DEFAULT_VUE_PLUGIN_LOCATION,
    )
  );
}

/** Resolve the catalog's plugin path against the source's package inside a monorepo. */
export async function vuePluginDirectory(
  source: string,
  root: string,
  paths: typeof path.posix,
  exists: (file: string) => Promise<boolean>,
): Promise<string> {
  for (let directory = paths.dirname(source); ; directory = paths.dirname(directory)) {
    const relative = paths.relative(root, directory);
    // Containment only, never probe packages outside the workspace.
    // oxlint-disable-next-line repo/no-parent-paths -- containment check only.
    if (relative.split(paths.sep)[0] === ".." || paths.isAbsolute(relative)) return root;
    if (directory === root || directory === paths.dirname(directory)) return root;
    if (await exists(paths.join(directory, VUE_PLUGIN, "package.json"))) return directory;
  }
}

/** Expand the project path in JSON initialization options, including plugin locations. */
export function resolveInitializationOptions(
  value: Record<string, unknown>,
  projectRoot: string,
  vuePluginRoot = projectRoot,
): Record<string, unknown> {
  const expand = (item: unknown): unknown => {
    if (item === DEFAULT_VUE_PLUGIN_LOCATION) return `${vuePluginRoot}/${VUE_PLUGIN}`;
    if (typeof item === "string") return item.replaceAll("{project}", () => projectRoot);
    if (Array.isArray(item)) return item.map(expand);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, expand(child)]));
    return item;
  };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
}
