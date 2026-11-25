import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmOperation } from "pi-agent-ide/api/approval";
import { registerAgentIdeSettings } from "pi-agent-ide/api/settings";
import type { FileOperationResolver } from "pi-agent-ide/api/text-editor";
import { ResourceError } from "pi-agent-ide/api/resource";
import { createLinearFields, parseLinearFieldAddress } from "./fields.ts";
import { linearOperationRoute } from "./operation-routes.ts";
import type { LinearOperationBackend, LinearOperationReceipt } from "./operation-backend.ts";
import { customerRequestSource } from "./customer-requests.ts";
import { isDocumentId } from "./urls.ts";
import { linearErrorRateLimit, safeLinearRateLimitInfo } from "./resource-failure.ts";

import type { LinearSemanticHandler as SemanticHandler } from "./semantic.ts";
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function key(source: string, content: string): string {
  return JSON.stringify([new URL(source).href, content]);
}
/** Shared policy grants permission; dispatch still consumes one exact-target, exact-payload permit. */
export function connectLinearPermissionGate(
  pi: Pick<ExtensionAPI, "events" | "on">,
  standalone: () => boolean = () => false,
) {
  registerAgentIdeSettings(pi, "pi-agent-linear", [
    {
      kind: "boolean",
      id: "pi-agent-linear-yolo",
      name: "Linear YOLO",
      description:
        "Skip confirmations for gated Linear actions. Identity, capability and payload guards still apply.",
      default: false,
      group: "features",
    },
  ]);
  const permits = new Set<string>();
  let approvalTail: Promise<unknown> = Promise.resolve();
  const dialogs = new Set<AbortController>();
  let authGeneration = 0;
  const clearPermits = () => {
    authGeneration++;
    permits.clear();
    for (const controller of dialogs) controller.abort();
  };
  const waiting = (active: boolean) => {
    try {
      pi.events.emit(
        "herdr:blocked",
        active ? { active: true, label: "Waiting for operation approval" } : { active: false },
      );
    } catch {
      /* Advisory presentation cannot change permission. */
    }
  };
  const confirmStandalone = (
    context: ExtensionContext,
    title: string,
    message: string,
  ): Promise<boolean> => {
    const controller = new AbortController();
    dialogs.add(controller);
    const signal = context.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;
    const decision = approvalTail
      .then(async () => {
        if (signal.aborted || !context.hasUI) return false;
        if (context.mode === "tui") waiting(true);
        try {
          return (await context.ui.confirm(title, message, { signal })) && !signal.aborted;
        } catch {
          return false;
        } finally {
          if (context.mode === "tui") waiting(false);
        }
      })
      .finally(() => dialogs.delete(controller));
    approvalTail = decision.catch(() => undefined);
    return decision;
  };
  pi.on("tool_call", async (event, context) => {
    const input = object(event.input);
    if (typeof input?.path !== "string") return;
    const address = parseLinearFieldAddress(input.path);
    if (!address) return;
    const toolName = event.toolName.startsWith("linear_")
      ? event.toolName.slice(7)
      : event.toolName;
    const route = linearOperationRoute(
      address.kind,
      toolName === "delete" ? "delete" : "write",
      address.facet === "fields" ? undefined : address.facet,
    );
    const mutation = ["write", "insert", "replace", "delete", "move"].includes(toolName);
    const dangerous =
      mutation && (toolName === "delete" || route?.dangerous || address.kind.startsWith("diff"));
    if (!dangerous) return;
    const content = typeof input.content === "string" ? input.content : "";
    const generation = authGeneration;
    const request = {
      owner: "pi-agent-linear",
      category: route?.operation ?? "external-review-change",
      yoloSetting: "pi-agent-linear-yolo",
      title: "Confirm Linear action",
      message: `${event.toolName}: ${input.path}\n${route?.operation ?? "external review change"}\n${content}`,
      signal: context.signal,
    };
    // No IDE settings or remembered YOLO grant may bypass a standalone confirmation.
    const allowed = standalone()
      ? await confirmStandalone(context, request.title, request.message)
      : await confirmOperation(pi.events, context, request);
    if (!allowed || context.signal?.aborted || generation !== authGeneration)
      return { block: true, reason: "LINEAR_CONFIRMATION_REQUIRED" };
    permits.add(key(input.path, content));
  });
  pi.on("tool_result", () => {
    permits.clear();
  });
  pi.on("session_shutdown", clearPermits);
  return Object.assign(
    (source: string, content: string) => {
      const value = key(source, content);
      if (!permits.delete(value))
        throw new ResourceError("LINEAR_CONFIRMATION_REQUIRED", source, "not-applied");
    },
    { clear: clearPermits },
  );
}
/** Keep canonical action links visible in compact ordinary-tool receipts. */
export function connectLinearOperationReceipts(pi: ExtensionAPI) {
  pi.on("tool_result", (event) => {
    // Standalone handlers already return their complete canonical receipt.
    if (event.toolName.startsWith("linear_")) return;
    const metadata = object(object(event.details)?.metadata);
    const action = object(metadata?.semanticAction);
    if (
      action?.kind !== "linear-operation" ||
      typeof action.source !== "string" ||
      !action.source.startsWith("linear://") ||
      (action.effect !== "applied" &&
        action.effect !== "not-applied" &&
        action.effect !== "unknown")
    )
      return;
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: `Read: ${action.source}\nEffect: ${action.effect}. Read again before another edit.`,
        },
      ],
      ...(event.structuredContent !== undefined
        ? { structuredContent: event.structuredContent }
        : {}),
      ...(action.effect !== "applied"
        ? { isError: true, details: { ...object(event.details), effect: action.effect } }
        : {}),
    };
  });
}
/** Typed domain requests stay within ordinary Write/Delete and a closed backend catalog. */
export function createLinearOperationHandlers(
  backend: LinearOperationBackend,
  requirePermit: (source: string, content: string) => void,
) {
  const fields = createLinearFields(backend, requirePermit);
  const write: SemanticHandler = {
    matches(value) {
      const input = object(value);
      if (typeof input?.path !== "string" || typeof input.content !== "string") return false;
      const address = parseLinearFieldAddress(input.path);
      return (
        !!address &&
        (address.id === "new" ||
          address.facet === "new" ||
          address.facet === "fields" ||
          !!(address.facet && linearOperationRoute(address.kind, "write", address.facet)))
      );
    },
    async execute(context, value) {
      const input = object(value);
      const source = typeof input?.path === "string" ? input.path : "";
      const content = input?.content;
      const address = parseLinearFieldAddress(source);
      if (!address || typeof content !== "string")
        throw new ResourceError("LINEAR_INVALID_FIELD_VALUE", source, "not-applied");
      const route =
        linearOperationRoute(
          address.kind,
          "write",
          address.facet === "fields" || address.id === "new" ? undefined : address.facet,
        ) ?? linearOperationRoute(address.kind, "write");
      if (!route) throw new ResourceError("LINEAR_OPERATION_UNAVAILABLE", source, "not-applied");
      // The field backend consumes the target-specific permit immediately before dispatch.
      const creation = address.id === "new" || address.facet === "new";
      let receipt: LinearOperationReceipt;
      try {
        receipt = await fields.write(source, content, context.cwd, context.signal);
      } catch (error) {
        const recovery =
          error instanceof ResourceError ? parseLinearFieldAddress(error.source) : undefined;
        if (
          creation &&
          address.kind === "workflow-template" &&
          error instanceof ResourceError &&
          error.effect === "unknown" &&
          recovery?.workspace === address.workspace &&
          recovery.kind === address.kind &&
          recovery.id &&
          isDocumentId(recovery.id)
        ) {
          const operation = "create_workflow_template";
          const rateLimit = linearErrorRateLimit(error);
          // The IDE's generic error formatter binds Path to /new; a semantic receipt retains recovery.
          return {
            source: error.source,
            summary: `Linear ${operation}: ${error.effect}.\nRead: ${error.source}\nDo not replay this creation.`,
            data: {
              kind: "linear-operation",
              workspace: address.workspace,
              operation,
              ok: false,
              effect: error.effect,
              error: error.code,
              targetId: recovery.id,
              source: error.source,
              ...(rateLimit ? { rateLimit } : {}),
            },
          };
        }
        throw error;
      }
      let canonical = source;
      const root = object(receipt.data);
      const row = object(root?.[address.kind]) ?? root;
      if (creation) {
        const id = address.kind === "issue" ? (row?.identifier ?? row?.id) : (row?.uuid ?? row?.id);
        if (typeof id !== "string" || !id || id === "new" || /[/#?]/u.test(id))
          throw new ResourceError("LINEAR_CREATION_RECEIPT_INVALID", source, "unknown");
        canonical = `linear://${address.workspace}/${address.kind}/${encodeURIComponent(id)}`;
        if (address.kind === "milestone") {
          const payload = object(JSON.parse(content));
          const project = payload?.project ?? address.parameters.project;
          if (typeof project !== "string" || !project)
            throw new ResourceError("LINEAR_CREATION_RECEIPT_INVALID", source, "unknown");
          const url = new URL(canonical);
          url.searchParams.set("project", project);
          canonical = url.href;
        }
        if (address.kind === "customer-request") {
          if (typeof row?.requestScopeProject !== "string")
            throw new ResourceError("LINEAR_CREATION_RECEIPT_INVALID", source, "unknown");
          canonical = customerRequestSource(address.workspace, id, row.requestScopeProject);
        }
        if (address.kind === "comment") {
          const payload = object(JSON.parse(content));
          for (const kind of ["project", "document"] as const) {
            const parent = payload?.[`${kind}Id`];
            if (typeof parent === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(parent)) {
              canonical = `linear://${address.workspace}/${kind}/${parent}/comment/${encodeURIComponent(id)}`;
              break;
            }
          }
        }
        if (["issue", "project", "document"].includes(address.kind)) {
          if (
            typeof row?.url !== "string" ||
            !row.url.startsWith(`https://linear.app/${address.workspace}/${address.kind}/`)
          )
            throw new ResourceError("LINEAR_CREATION_RECEIPT_INVALID", source, "unknown");
        }
      }
      return {
        source: canonical,
        summary: `Linear ${receipt.operation}: ${receipt.effect}.\nRead: ${canonical}\nRead again before editing. Uncertain effects must never be replayed.`,
        data: { kind: "linear-operation", ...receipt, source: canonical },
        ...(receipt.effect === "applied" && !receipt.error
          ? { script: { source: canonical } }
          : {}),
      };
    },
  };
  const insert: SemanticHandler = {
    matches(value) {
      const input = object(value);
      if (typeof input?.path !== "string" || typeof input.text !== "string") return false;
      const address = parseLinearFieldAddress(input.path);
      return (
        address?.facet === "labels" &&
        !!address.id &&
        input.after === "end" &&
        input.before === undefined
      );
    },
    async execute(context, value) {
      const input = object(value);
      const source = typeof input?.path === "string" ? input.path : "";
      const text = input?.text;
      if (!source || typeof text !== "string")
        throw new ResourceError("LINEAR_INVALID_FIELD_VALUE", source, "not-applied");
      const current = await fields.read(source, context.cwd, context.signal);
      const existing: unknown = current.startsWith("[")
        ? JSON.parse(current)
        : current.split(/\r?\n/u).filter(Boolean);
      const addition: unknown = text.trimStart().startsWith("[")
        ? JSON.parse(text)
        : text.split(/\r?\n/u).filter(Boolean);
      if (!isStringArray(existing) || !isStringArray(addition))
        throw new ResourceError("LINEAR_INVALID_FIELD_VALUE", source, "not-applied");
      const content = JSON.stringify([...new Set([...existing, ...addition])]);
      const receipt = await fields.write(source, content, context.cwd, context.signal);
      return {
        source,
        summary: `Linear labels added: ${receipt.effect}.\nRead: ${source}`,
        data: { kind: "linear-operation", ...receipt, source },
        ...(receipt.effect === "applied" && !receipt.error ? { script: { source } } : {}),
      };
    },
  };
  const fileOperations: FileOperationResolver = async (operation, input, context) => {
    if (operation !== "delete") return undefined;
    const address = parseLinearFieldAddress(input.path);
    const route = address && linearOperationRoute(address.kind, "delete", address.facet);
    if (!address || !route) return undefined;
    requirePermit(input.path, "");
    if (!route.identity || !address.id || address.id === "new")
      throw new ResourceError("LINEAR_IDENTITY_REQUIRED", input.path, "not-applied");
    const receipt = await backend.invoke(
      address.workspace,
      route.operation,
      { ...address.parameters, [route.identity]: address.id },
      context.cwd,
      context.signal,
    );
    const rateLimit = safeLinearRateLimitInfo(receipt.rateLimit);
    return {
      kind: "file-operation",
      operation,
      ok: receipt.effect === "applied" && !receipt.error,
      effect: receipt.effect,
      path: input.path,
      ...(receipt.error
        ? {
            error: {
              code: receipt.error,
              message: receipt.error,
              ...(rateLimit ? { rateLimit } : {}),
            },
          }
        : {}),
    };
  };
  return { write, insert, fileOperations, fields };
}
