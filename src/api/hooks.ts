import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL, type ReadRequest } from "./read.js";
import {
  connectTextEditorPlugin,
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type AppliedTextChange,
  type TextDocument,
} from "./text-editor.js";

/** The decision returned by a file policy hook. */
export type FileHookDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: string };

/** A resolved Resource that is about to be read. */
export interface BeforeReadEvent {
  readonly requestedSource: string;
  readonly resourceSource: string;
  readonly resolvedBy: string;
  readonly cwd: string;
  readonly request: ReadRequest;
  readonly audience: "agent" | "script";
  readonly signal?: AbortSignal;
}

export interface BeforeReadHook {
  readonly id: string;
  run(event: BeforeReadEvent): FileHookDecision | Promise<FileHookDecision>;
}

/** A complete, resolved mutation plan before its first write. */
export interface BeforeEditEvent {
  readonly cwd: string;
  readonly intent: "edit" | "restore" | "mixed";
  readonly resources: readonly {
    readonly resourceSource: string;
    readonly existed: boolean;
    readonly before: TextDocument;
    readonly after: TextDocument;
    readonly changes: readonly AppliedTextChange[];
  }[];
  readonly signal?: AbortSignal;
}

export interface BeforeEditHook {
  readonly id: string;
  run(event: BeforeEditEvent): FileHookDecision | Promise<FileHookDecision>;
}

/** A final saved Resource after post-processing and rereading. */
export interface AfterEditEvent {
  readonly source: string;
  readonly resourceSource: string;
  readonly resolvedBy: string;
  readonly cwd: string;
  readonly existed: boolean;
  readonly before: TextDocument;
  readonly after: TextDocument;
  readonly intent: "edit" | "restore" | "mixed";
  readonly signal?: AbortSignal;
}

export type AfterEditResult = void | {
  readonly feedback: string;
  readonly tone?: "info" | "warning" | "error";
};

export interface AfterEditHook {
  readonly id: string;
  run(event: AfterEditEvent): AfterEditResult | Promise<AfterEditResult>;
}

/** Register a fail-closed policy over resolved Resources before content is read. */
export function connectBeforeReadHook(
  pi: ExtensionAPI,
  hook: BeforeReadHook,
): void | Promise<void> {
  assertHook(hook);
  return connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: `hook/before-read/${hook.id}`,
    setup(api) {
      api.addResourceGuard({
        id: hook.id,
        async guard(event) {
          const result = await hook.run(event);
          return result.decision === "allow"
            ? { kind: "accepted" }
            : { kind: "rejected", reason: result.reason };
        },
      });
    },
  });
}

/** Register a fail-closed policy over complete mutation plans before writing. */
export function connectBeforeEditHook(
  pi: ExtensionAPI,
  hook: BeforeEditHook,
): void | Promise<void> {
  assertHook(hook);
  return connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: `hook/before-edit/${hook.id}`,
    setup(api) {
      api.addMutationGuard({
        id: hook.id,
        async guard(plan, context) {
          const decision = await hook.run({
            cwd: context.cwd,
            intent: context.intent ?? "edit",
            resources: plan.resources.map((resource) => ({
              resourceSource: resource.source,
              existed: resource.existed,
              before: resource.before,
              after: resource.after,
              changes: resource.changes,
            })),
            ...(context.signal !== undefined && { signal: context.signal }),
          });
          return decision.decision === "allow"
            ? { kind: "accepted" }
            : {
                kind: "rejected",
                rejection: {
                  code: "MUTATION_REJECTED",
                  reason: decision.reason,
                  message: `Edit blocked by hook ${hook.id}: ${decision.reason}`,
                  effect: "not-applied",
                },
              };
        },
      });
    },
  });
}

/** Register an advisory check over final saved edits. Feedback never rolls back the write. */
export function connectAfterEditHook(pi: ExtensionAPI, hook: AfterEditHook): void | Promise<void> {
  assertHook(hook);
  return connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: `hook/after-edit/${hook.id}`,
    setup(api) {
      api.onDidEdit(async (completion) => {
        if (completion.postProcessing === "deferred") return;
        try {
          return await hook.run(completion);
        } catch (error) {
          return {
            feedback: `After-edit hook ${hook.id} failed after the edit was saved: ${error instanceof Error ? error.message : String(error)}`,
            tone: "error" as const,
          };
        }
      });
    },
  });
}

function assertHook(hook: { readonly id: string; readonly run: unknown }): void {
  if (hook.id.trim().length === 0 || typeof hook.run !== "function") {
    throw new TypeError("A file hook needs a non-empty id and run function");
  }
}
