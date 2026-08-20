import type {
  ActiveToolchain,
  Compiler,
  Formatter,
  IdeTool,
  Linter,
  ToolContext,
} from "./types.js";

const formatters: Formatter[] = [];
const compilers: Compiler[] = [];
const linters: Linter[] = [];

let activeToolchain: ActiveToolchain | undefined;

// ── Registration ──────────────────────────────────────────────────

function assertUniqueName(kind: string, list: readonly { name: string }[], name: string): void {
  if (list.some((tool) => tool.name === name)) {
    throw new Error(`[pi-agent-ide] ${kind} "${name}" is already registered. Use a unique name.`);
  }
}

export function registerTools(tools: readonly IdeTool[]): void {
  const draftNames = new Set<string>();

  for (const tool of tools) {
    const key = `${tool.kind}:${tool.name}`;

    if (draftNames.has(key)) {
      throw new Error(
        `[pi-agent-ide] ${tool.kind} "${tool.name}" is registered twice by one plugin.`,
      );
    }

    draftNames.add(key);

    switch (tool.kind) {
      case "compiler": {
        assertUniqueName(tool.kind, compilers, tool.name);
        break;
      }
      case "formatter": {
        assertUniqueName(tool.kind, formatters, tool.name);
        break;
      }
      case "linter": {
        assertUniqueName(tool.kind, linters, tool.name);
        break;
      }
    }
  }

  for (const tool of tools) {
    switch (tool.kind) {
      case "compiler": {
        compilers.push(tool);
        break;
      }
      case "formatter": {
        formatters.push(tool);
        break;
      }
      case "linter": {
        linters.push(tool);
        break;
      }
    }
  }
}

export function registerFormatter(formatter: Formatter): void {
  registerTools([formatter]);
}

export function registerCompiler(compiler: Compiler): void {
  registerTools([compiler]);
}

export function registerLinter(linter: Linter): void {
  registerTools([linter]);
}

// ── Introspection ──────────────────────────────────────────────────

export interface RegisteredToolInfo {
  name: string;
  priority: number;
  extensions: readonly string[];
}

export interface RegisteredSnapshot {
  formatters: RegisteredToolInfo[];
  compilers: RegisteredToolInfo[];
  linters: RegisteredToolInfo[];
}

export function listRegistered(): RegisteredSnapshot {
  const toInfo = (t: {
    name: string;
    priority: number;
    extensions: readonly string[];
  }): RegisteredToolInfo => ({
    name: t.name,
    priority: t.priority,
    extensions: t.extensions,
  });
  return {
    formatters: formatters.map((t) => toInfo(t)),
    compilers: compilers.map((t) => toInfo(t)),
    linters: linters.map((t) => toInfo(t)),
  };
}

// ── Warmup ────────────────────────────────────────────────────────

interface DetectableTool {
  name: string;
  priority: number;
  extensions: readonly string[];
  detect(context: ToolContext): Promise<boolean>;
}

async function filterActive<T extends DetectableTool>(
  tools: readonly T[],
  context: ToolContext,
): Promise<T[]> {
  const active: T[] = [];

  for (const tool of tools) {
    try {
      if (await tool.detect(context)) {
        active.push(tool);
      }
    } catch (error) {
      console.error(`[pi-agent-ide] detect failed for "${tool.name}":`, error);
    }
  }

  active.sort((a, b) => b.priority - a.priority);
  assertNoPriorityConflicts(active);
  return active;
}

/**
 * Two active tools of the same kind with the same priority claiming the same
 * extension is ambiguous — reject it loudly instead of picking one silently.
 * "*" is treated as a distinct extension slot that can only be held by one tool
 * per priority (typically the skip/fallback).
 */
function assertNoPriorityConflicts(active: readonly DetectableTool[]): void {
  const seen = new Map<string, string>();

  for (const tool of active) {
    for (const extension of tool.extensions) {
      const key = `${extension}@${tool.priority}`;
      const previous = seen.get(key);

      if (previous !== undefined) {
        throw new Error(
          `[pi-agent-ide] priority conflict: tools "${previous}" and "${tool.name}" both claim "${extension}" at priority ${tool.priority}.`,
        );
      }

      seen.set(key, tool.name);
    }
  }
}

export async function warmup(context: ToolContext): Promise<ActiveToolchain> {
  const [fmts, comps, lnts] = await Promise.all([
    filterActive(formatters, context),
    filterActive(compilers, context),
    filterActive(linters, context),
  ]);

  activeToolchain = { ctx: context, formatters: fmts, compilers: comps, linters: lnts };
  return activeToolchain;
}

export function getActiveToolchain(): ActiveToolchain {
  if (activeToolchain === undefined) {
    // Graceful default: no tools active → everything resolves to skip-like.
    return { ctx: { cwd: process.cwd() }, formatters: [], compilers: [], linters: [] };
  }

  return activeToolchain;
}

export function isToolchainReady(): boolean {
  return activeToolchain !== undefined;
}

// ── Runtime lifecycle ─────────────────────────────────────────────

export function resetRegistry(): void {
  formatters.length = 0;
  compilers.length = 0;
  linters.length = 0;
  activeToolchain = undefined;
}
