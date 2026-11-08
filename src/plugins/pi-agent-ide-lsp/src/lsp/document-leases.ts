import { AsyncLocalStorage } from "node:async_hooks";

import type { LspClient } from "./client.ts";

/** Documents one operation keeps open, released together when it finishes. */
type DocumentScope = Map<LspClient, Map<string, () => void>>;

const operation = new AsyncLocalStorage<DocumentScope>();

/**
 * Run one language-server operation. Documents opened during it stay open until it finishes,
 * then close unless another operation still uses them. Nested calls join the outer operation.
 */
export async function withLspDocuments<T>(run: () => Promise<T>): Promise<T> {
  if (operation.getStore() !== undefined) return run();
  const scope: DocumentScope = new Map();
  try {
    return await operation.run(scope, run);
  } finally {
    for (const releases of scope.values()) for (const release of releases.values()) release();
  }
}

/** Keep a document open for the current operation; outside an operation it stays open. */
export function retainForCurrentOperation(client: LspClient, uri: string): void {
  const scope = operation.getStore();
  if (scope === undefined) return;
  const releases = scope.get(client) ?? new Map<string, () => void>();
  scope.set(client, releases);
  if (!releases.has(uri)) releases.set(uri, client.retainDocument(uri));
}
