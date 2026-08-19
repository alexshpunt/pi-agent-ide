export { LspClient } from "./client.js";

export { requestDiagnostics } from "./diagnostics.js";

export {
    findDocumentSymbol,
    findWorkspaceSymbol,
    requestDocumentSymbols,
    requestWorkspaceSymbols,
    symbolKindName,
} from "./symbols.js";

export { requestRename, workspaceEditEntries } from "./rename.js";

export { searchSymbols } from "./symbol-search.js";

export type { SymbolHit } from "./symbol-search.js";

export type { LspWorkspaceEdit } from "./rename.js";

export type { LspWorkspaceSymbol } from "./symbols.js";

export { requestCallHierarchy, requestReferences } from "./navigation.js";

export { readLspFileGraph, readLspSymbolBody, readLspSymbolGraph, resolveLspCodeSymbol } from "./code-views.js";

export type { LspCodeSymbol } from "./code-views.js";

export type {
    LspCallHierarchyItem,
    LspCallHierarchyResult,
    LspIncomingCall,
    LspLocation,
    LspOutgoingCall,
} from "./navigation.js";

export { createLspCompiler } from "./lsp-compiler.js";

export { LspManager } from "./manager.js";

export type { LspPushDiagnosticsEvent } from "./manager.js";

export { LspServerRegistry } from "./registry.js";

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
} from "./types.js";

export { DiagnosticSeverity as LspSeverity } from "./types.js";

export type { LspDocumentSymbol } from "./symbols.js";
