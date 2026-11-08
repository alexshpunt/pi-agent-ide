export { LspClient } from "./client.ts";

export { requestDiagnostics } from "./diagnostics.ts";

export {
  findDocumentSymbol,
  findWorkspaceSymbol,
  requestDocumentSymbols,
  requestWorkspaceSymbols,
  symbolKindName,
} from "./symbols.ts";

export { requestRename, workspaceEditEntries } from "./rename.ts";

export { searchSymbols } from "./symbol-search.ts";

export type { SymbolHit } from "./symbol-search.ts";

export type { LspWorkspaceEdit } from "./rename.ts";

export type { LspWorkspaceSymbol } from "./symbols.ts";

export { requestCallHierarchy, requestReferences } from "./navigation.ts";

export { readLspFileGraph, readLspSymbolGraph, resolveLspCodeSymbol } from "./code-views.ts";

export type { LspCodeSymbol } from "./code-views.ts";

export type {
  LspCallHierarchyItem,
  LspCallHierarchyResult,
  LspIncomingCall,
  LspLocation,
  LspOutgoingCall,
} from "./navigation.ts";

export { createLspCompiler } from "./lsp-compiler.ts";

export { LspManager } from "./manager.ts";

export type { LspPushDiagnosticsEvent } from "./manager.ts";

export { LspServerRegistry } from "./registry.ts";

export type {
  DiagnosticSeverity,
  LanguageEntry,
  LspDiagnostic,
  LspPosition,
  LspRange,
  LspTextEdit,
  ResolvedServer,
  ServerCapability,
  ServerConfig,
} from "./types.ts";

export { DiagnosticSeverity as LspSeverity } from "./types.ts";

export type { LspDocumentSymbol } from "./symbols.ts";
