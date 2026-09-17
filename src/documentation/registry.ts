import type { AgentDocumentation } from "#src/api/documentation.js";

const DOCUMENT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** Ordered registry for currently enabled agent documentation. */
export class AgentDocumentationRegistry {
  readonly #documents = new Map<string, AgentDocumentation>();

  register(documents: readonly AgentDocumentation[]): void {
    const ids = new Set(this.#documents.keys());
    for (const document of documents) {
      validateDocument(document, ids);
      ids.add(document.id);
    }
    for (const document of documents) this.#documents.set(document.id, freezeDocument(document));
  }

  list(): readonly AgentDocumentation[] {
    return [...this.#documents.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  get(id: string): AgentDocumentation | undefined {
    return this.#documents.get(id);
  }

  matching(toolName: string, input: unknown): readonly AgentDocumentation[] {
    const resourcePath = readPath(input);
    if (resourcePath?.startsWith("docs:") === true) return [];
    return this.list().filter((document) =>
      document.triggers.some((trigger) => {
        if (trigger.tool !== toolName) return false;
        const resourceMatches =
          trigger.resourcePrefixes === undefined ||
          (resourcePath !== undefined &&
            trigger.resourcePrefixes.some((prefix) => resourcePath.startsWith(prefix)));
        const viewMatches =
          trigger.viewPrefixes === undefined ||
          readViews(input).some((view) =>
            trigger.viewPrefixes?.some((prefix) => view.startsWith(prefix)),
          );
        return resourceMatches && viewMatches;
      }),
    );
  }
}

function validateDocument(document: AgentDocumentation, existingIds: ReadonlySet<string>): void {
  if (!DOCUMENT_ID.test(document.id)) throw new Error(`Invalid documentation ID: ${document.id}`);
  if (document.description.trim().length === 0)
    throw new Error(`Documentation ${document.id} has no description`);
  if (document.markdown.trim().length === 0)
    throw new Error(`Documentation ${document.id} has no Markdown content`);
  if (
    document.triggers.length === 0 ||
    document.triggers.some(
      (trigger) =>
        trigger.tool.trim().length === 0 ||
        trigger.resourcePrefixes?.some((prefix) => prefix.length === 0) === true ||
        trigger.viewPrefixes?.some((prefix) => prefix.length === 0) === true,
    )
  )
    throw new Error(`Documentation ${document.id} has no valid triggers`);
  if (existingIds.has(document.id))
    throw new Error(`Documentation ${document.id} is already registered`);
}

function freezeDocument(document: AgentDocumentation): AgentDocumentation {
  return Object.freeze({
    ...document,
    triggers: Object.freeze(
      document.triggers.map((trigger) =>
        Object.freeze({
          ...trigger,
          ...(trigger.resourcePrefixes === undefined
            ? {}
            : { resourcePrefixes: Object.freeze([...trigger.resourcePrefixes]) }),
          ...(trigger.viewPrefixes === undefined
            ? {}
            : { viewPrefixes: Object.freeze([...trigger.viewPrefixes]) }),
        }),
      ),
    ),
  });
}

function readViews(input: unknown): readonly string[] {
  if (typeof input !== "object" || input === null) return [];
  const views = (input as { readonly views?: unknown }).views;
  return Array.isArray(views)
    ? views.filter((view): view is string => typeof view === "string")
    : [];
}

function readPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const path = (input as { readonly path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
}
