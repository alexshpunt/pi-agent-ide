import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  ResourceError,
  type AgentContent,
  type Resource,
  type ResourceResolver,
  type ResultTargetStore,
} from "pi-agent-ide/api/resource";
import type { ReadPostReadHandler, ReadToolResult } from "pi-agent-ide/api/read";
import type { FileOperationResolver } from "pi-agent-ide/api/text-editor";
import type { LinearSemanticHandler } from "./semantic.ts";

export interface LinearAuthEpoch {
  readonly connectionId?: string;
  readonly epoch: string;
  readonly state: string;
}
export interface LinearAuthBoundaryOptions {
  readonly readEpoch: (cwd: string, signal?: AbortSignal) => Promise<LinearAuthEpoch>;
  /** Reset provider-owned caches/permits. Sources are canonical Linear identities only. */
  readonly onChange: (cwd: string, sources: readonly string[]) => void;
  readonly targets?: ResultTargetStore;
}
interface Operation {
  readonly connectionId?: string;
  readonly cwd: string;
  readonly epoch: string;
}
interface Acquisition extends Operation {
  readonly source: string;
}
const operations = new AsyncLocalStorage<Operation>();

/** An operation's original principal, never a mutable process-wide environment override. */
export function currentLinearConnectionId(): string | undefined {
  return operations.getStore()?.connectionId;
}
export function currentLinearAuthEpoch(): string | undefined {
  return operations.getStore()?.epoch;
}
function owned(source: string): boolean {
  if (source.startsWith("linear://")) return true;
  try {
    const url = new URL(source);
    return (
      url.protocol === "https:" &&
      url.hostname === "linear.app" &&
      /^\/[A-Za-z0-9_-]+\//u.test(url.pathname) &&
      !/^\/(?:docs|developers|oauth|settings|login)\//u.test(url.pathname)
    );
  } catch {
    return false;
  }
}
function fail(code: string, source: string): never {
  throw new ResourceError(code, source, "not-applied");
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Bind provider resources and mutations to an explicit auth generation. */
export function createLinearAuthBoundary(options: LinearAuthBoundaryOptions) {
  const epochs = new Map<string, string>();
  const sources = new Map<string, Set<string>>();
  let acquisitions = new WeakMap<object, Acquisition>();
  const track = (cwd: string, source: string) => {
    if (!owned(source)) return;
    const root = path.resolve(cwd);
    const values = sources.get(root) ?? new Set<string>();
    values.add(source);
    sources.set(root, values);
  };
  function invalidate(cwd: string): void {
    const root = path.resolve(cwd);
    const selected = [...(sources.get(root) ?? [])];
    for (const source of selected) options.targets?.invalidate(source);
    options.onChange(root, selected);
  }
  async function epoch(cwd: string, signal?: AbortSignal): Promise<Operation> {
    signal?.throwIfAborted();
    let result: Record<string, unknown> | undefined;
    try {
      result = record(await options.readEpoch(cwd, signal));
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof Error &&
        /^LINEAR_AUTH_(?:CONNECTION_REMOVED|SELECTION_REQUIRED|REQUIRED)$/u.test(error.message)
      )
        return fail(error.message, "linear-auth");
      return fail("LINEAR_AUTH_CONTEXT_UNAVAILABLE", "linear-auth");
    }
    if (
      !result ||
      typeof result.epoch !== "string" ||
      !result.epoch ||
      typeof result.state !== "string" ||
      (result.connectionId !== undefined && typeof result.connectionId !== "string")
    )
      fail("LINEAR_AUTH_CONTEXT_UNAVAILABLE", "linear-auth");
    const root = path.resolve(cwd);
    const previous = epochs.get(root);
    if (previous !== undefined && previous !== result.epoch) invalidate(root);
    epochs.set(root, result.epoch);
    if (result.state === "signed-out") fail("LINEAR_AUTH_REQUIRED", "linear-auth");
    return { cwd: root, epoch: result.epoch, connectionId: result.connectionId };
  }
  async function pinned<T>(
    operation: Operation,
    signal: AbortSignal | undefined,
    execute: () => Promise<T>,
  ): Promise<T> {
    const actual = await epoch(operation.cwd, signal);
    const outer = operations.getStore();
    if (
      actual.epoch !== operation.epoch ||
      actual.connectionId !== operation.connectionId ||
      (outer &&
        (outer.cwd !== operation.cwd ||
          outer.epoch !== operation.epoch ||
          outer.connectionId !== operation.connectionId))
    ) {
      fail("LINEAR_AUTH_CHANGED", "linear-auth");
    }
    return operations.run(operation, execute);
  }
  async function run<T>(
    cwd: string,
    signal: AbortSignal | undefined,
    execute: () => Promise<T>,
  ): Promise<T> {
    const outer = operations.getStore();
    const current = await epoch(cwd, signal);
    if (
      outer &&
      (outer.cwd !== current.cwd ||
        outer.epoch !== current.epoch ||
        outer.connectionId !== current.connectionId)
    )
      fail("LINEAR_AUTH_CHANGED", "linear-auth");
    return operations.run(outer ?? current, execute);
  }
  function wrapResource(resource: Resource, operation: Operation): Resource {
    track(operation.cwd, resource.source);
    // Keep sourceBytes dynamic: some backends update this getter after a save.
    const result = Object.create(resource) as Resource;
    if (resource.read) {
      const read = resource.read.bind(resource);
      Object.defineProperty(result, "read", {
        value: async (context: { signal?: AbortSignal }) => {
          const reading = { ...operation };
          const content = await pinned(reading, context.signal, () => read(context));
          await pinned(reading, context.signal, async () => undefined);
          const acquired = { ...reading, source: resource.source };
          acquisitions.set(content, acquired);
          for (const block of content) acquisitions.set(block, acquired);
          return content;
        },
      });
    }
    if (resource.readBytes) {
      const readBytes = resource.readBytes.bind(resource);
      Object.defineProperty(result, "readBytes", {
        value: async (
          offset: number,
          limit: number | undefined,
          context: { signal?: AbortSignal },
        ) => {
          const value = await pinned(operation, context.signal, () =>
            readBytes(offset, limit, context),
          );
          await pinned(operation, context.signal, async () => undefined);
          return value;
        },
      });
    }
    if (resource.write) {
      const write = resource.write.bind(resource);
      Object.defineProperty(result, "write", {
        value: (content: AgentContent, context: { signal?: AbortSignal }) =>
          pinned(operation, context.signal, async () => {
            await write(content, context);
          }),
      });
    }
    return result;
  }
  function resolver(inner: ResourceResolver): ResourceResolver {
    return {
      id: inner.id,
      async tryResolve(source, context) {
        if (!owned(source)) return inner.tryResolve(source, context);
        return run(context.cwd, context.signal, async () => {
          const operation = operations.getStore();
          if (!operation) fail("LINEAR_AUTH_CONTEXT_UNAVAILABLE", "linear-auth");
          const attempt = await inner.tryResolve(source, context);
          if (attempt.kind !== "resolved") return attempt;
          await pinned(operation, context.signal, async () => undefined);
          track(context.cwd, source);
          return { kind: "resolved", resource: wrapResource(attempt.resource, operation) };
        });
      },
    };
  }
  const postRead: ReadPostReadHandler = async (context) => {
    const state = context.state;
    if (
      state?.contentKind !== "text" ||
      !owned(state.source) ||
      context.sourceText !== state.text.content
    )
      return { kind: "continue", context };
    const acquired = acquisitions.get(state.content) ?? acquisitions.get(state.content[0]);
    if (
      !acquired ||
      acquired.source !== state.source ||
      acquired.cwd !== path.resolve(context.resolverContext.cwd)
    )
      return { kind: "continue", context };
    await pinned(acquired, context.resolverContext.signal, async () => undefined);
    return {
      kind: "continue",
      context,
      transform(result: ReadToolResult) {
        const script = result.script;
        if (result.isError || script?.kind !== "text" || script.source !== state.source)
          return result;
        if (epochs.get(acquired.cwd) !== acquired.epoch) fail("LINEAR_AUTH_CHANGED", state.source);
        if (!script.target || !options.targets) return result;
        const selected = options.targets.resolve(script.target, acquired.cwd);
        const guarded = options.targets.register(
          selected.targets.map((target) => {
            const readCurrent = target.readCurrent?.bind(target);
            return readCurrent
              ? {
                  ...target,
                  readCurrent: (signal?: AbortSignal) =>
                    pinned(acquired, signal, () => readCurrent(signal)),
                }
              : target;
          }),
          acquired.cwd,
          selected.complete,
        );
        return { ...result, script: { ...script, target: guarded } };
      },
    };
  };
  function semantic(inner: LinearSemanticHandler): LinearSemanticHandler {
    return {
      matches: inner.matches,
      async execute(context, input) {
        const value = record(input);
        const source = typeof value?.path === "string" ? value.path : undefined;
        if (!source || !owned(source)) return inner.execute(context, input);
        return run(context.cwd, context.signal, async () => {
          track(context.cwd, source);
          return inner.execute(context, input);
        });
      },
    };
  }
  function fileOperations(inner: FileOperationResolver): FileOperationResolver {
    return (operation, input, context, policy) => {
      if (!owned(input.path) && (!input.target || !owned(input.target)))
        return inner(operation, input, context, policy);
      return run(context.cwd, context.signal, () => inner(operation, input, context, policy));
    };
  }
  function clear(): void {
    for (const root of sources.keys()) invalidate(root);
    epochs.clear();
    sources.clear();
    acquisitions = new WeakMap();
  }
  return { run, resolver, semantic, fileOperations, postRead, clear };
}
