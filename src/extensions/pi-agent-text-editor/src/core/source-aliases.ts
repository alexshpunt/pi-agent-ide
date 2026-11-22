import { resourceAccesses } from "pi-agent-resource";
import type {
  TextMutation,
  TextMutationContext,
  TextMutationEdit,
} from "#src/api/mutation-tool.ts";

/** Maps every alias of a resource to the one name used for its edits; unaliased names are absent. */
export type SourceAliases = ReadonlyMap<string, string>;

/**
 * Find sources that name one resource, such as a relative path, an absolute path and a symlink to
 * the same file. The first name listed wins. A source whose identity cannot be determined stays
 * its own resource.
 */
export async function findSourceAliases(
  sources: readonly string[],
  cwd: string,
): Promise<SourceAliases> {
  const unique = [...new Set(sources)];
  if (unique.length < 2) return new Map();
  const owners = new Map<string, string>();
  const aliases = new Map<string, string>();
  const identities = await Promise.all(
    unique.map(async (source) => {
      try {
        return (await resourceAccesses(source, cwd, "write")).map(({ resource }) => resource);
      } catch {
        return [];
      }
    }),
  );
  for (const [index, source] of unique.entries()) {
    let canonical: string | undefined;
    for (const resource of identities[index] ?? []) {
      const owner = owners.get(resource);
      if (owner !== undefined && owner !== source) {
        canonical = owner;
        break;
      }
    }
    if (canonical !== undefined) aliases.set(source, canonical);
    for (const resource of identities[index] ?? []) owners.set(resource, canonical ?? source);
  }
  return aliases;
}

const contextAliases = new WeakMap<TextMutationContext, SourceAliases>();

/** Record the aliases of the resources a mutation context was built for. */
export function bindContextAliases(context: TextMutationContext, aliases: SourceAliases): void {
  contextAliases.set(context, aliases);
}

/** Rename the edit keys of a mutation made with `context` to the context's canonical sources. */
export function canonicalizeContextEdits(
  mutation: TextMutation,
  context: TextMutationContext,
): TextMutation {
  return canonicalizeMutationEdits(mutation, contextAliases.get(context) ?? new Map());
}

/** Rename aliased edit keys to their canonical source, keeping the order of their changes. */
export function canonicalizeMutationEdits(
  mutation: TextMutation,
  aliases: SourceAliases,
): TextMutation {
  if (aliases.size === 0 || [...mutation.edits.keys()].every((source) => !aliases.has(source)))
    return mutation;
  const edits = new Map<string, TextMutationEdit>();
  for (const [source, edit] of mutation.edits) {
    const canonical = aliases.get(source) ?? source;
    const previous = edits.get(canonical);
    if (previous === undefined) {
      edits.set(canonical, edit);
      continue;
    }
    const offset = previous.changes.length;
    const indices = (item: TextMutationEdit, base: number) =>
      (item.resultChanges ?? Array.from(item.changes.keys())).map((index) => index + base);
    const resultChanges = [...indices(previous, 0), ...indices(edit, offset)];
    edits.set(canonical, {
      changes: [...previous.changes, ...edit.changes],
      action:
        previous.action === "overwritten" || edit.action === "overwritten"
          ? "overwritten"
          : "edited",
      resultChanges,
    });
  }
  return { ...mutation, edits };
}
