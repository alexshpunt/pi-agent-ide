import type { LspManager } from "./lsp/index.ts";

/** Resolve the language-server manager that owns a source, starting it on first use. */
export type LspManagerProvider = (
  cwd: string,
  filePath?: string,
  signal?: AbortSignal,
) => Promise<LspManager>;
