import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResourceError } from "pi-agent-ide/api/resource";
import { decodeAxiObject, runAxi } from "./axi.ts";
import { LINEAR_OPERATION_ROUTES } from "./operation-routes.ts";
import {
  linearErrorRateLimit,
  linearResourceError,
  parseLinearResourceFailure,
  safeLinearRateLimitInfo,
  type LinearRateLimitInfo,
} from "./resource-failure.ts";

/** A public backend operation schema, never authorization data. */
export interface LinearOperationCapability {
  readonly name: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<Record<string, unknown>>;
}

/** Preserve the backend's known effect; an uncertain call must not be replayed. */
export interface LinearOperationReceipt {
  readonly workspace: string;
  readonly operation: string;
  readonly effect: "applied" | "not-applied" | "unknown";
  readonly data?: unknown;
  /** Native creation correlation, retained even when the dispatch outcome is unknown. */
  readonly targetId?: string;
  readonly error?: string;
  readonly rateLimit?: LinearRateLimitInfo;
}

/** Existing AXI owns workspace verification, schema validation and credentials. */
export interface LinearOperationBackend {
  capabilities(
    workspace: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<readonly LinearOperationCapability[]>;
  invoke(
    workspace: string,
    operation: string,
    input: Readonly<Record<string, unknown>>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<LinearOperationReceipt>;
}

function isOperationInput(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("LINEAR_INVALID_CAPABILITIES");
  return value as Record<string, unknown>;
}
function checkedWorkspace(workspace: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(workspace))
    throw new ResourceError("LINEAR_INVALID_WORKSPACE", "linear://", "not-applied");
}
function safeCode(error: unknown, fallback = "LINEAR_OPERATION_FAILED"): string {
  if (error instanceof ResourceError) return error.code;
  return error instanceof Error && /^LINEAR_[A-Z_]+$/u.test(error.message)
    ? error.message
    : fallback;
}

/** Bounded private JSON transport to the backend's closed operation catalog. */
export function createLinearOperationBackend(run: typeof runAxi = runAxi): LinearOperationBackend {
  return {
    async capabilities(workspace, cwd, signal) {
      checkedWorkspace(workspace);
      signal?.throwIfAborted();
      let output: string;
      try {
        output = await run(cwd, ["resources", "capabilities", "--workspace", workspace], signal);
      } catch (error) {
        signal?.throwIfAborted();
        throw linearResourceError(
          safeCode(error, "LINEAR_CAPABILITIES_UNKNOWN"),
          `linear://${workspace}`,
          "not-applied",
          linearErrorRateLimit(error),
        );
      }
      try {
        const root = record(
          decodeAxiObject(output, "capabilities", ["workspace", "items"]).capabilities,
        );
        if (root.workspace !== workspace || !Array.isArray(root.items) || root.items.length > 256)
          throw new Error("LINEAR_INVALID_CAPABILITIES");
        const seen = new Set<string>();
        return root.items.map((value) => {
          const item = record(value);
          if (
            typeof item.name !== "string" ||
            !/^[a-z][a-z0-9_]*$/u.test(item.name) ||
            seen.has(item.name) ||
            typeof item.inputSchema !== "string" ||
            typeof item.annotations !== "string"
          )
            throw new Error("LINEAR_INVALID_CAPABILITIES");
          seen.add(item.name);
          return {
            name: item.name,
            inputSchema: record(JSON.parse(item.inputSchema)),
            annotations: record(JSON.parse(item.annotations)),
          };
        });
      } catch {
        throw new Error("LINEAR_INVALID_CAPABILITIES");
      }
    },
    async invoke(workspace, operation, input, cwd, signal) {
      checkedWorkspace(workspace);
      signal?.throwIfAborted();
      if (!/^[a-z][a-z0-9_]*$/u.test(operation) || !isOperationInput(input))
        throw new ResourceError(
          "LINEAR_INVALID_OPERATION_INPUT",
          `linear://${workspace}`,
          "not-applied",
        );
      const readOnly = LINEAR_OPERATION_ROUTES.some(
        (route) => route.operation === operation && route.mode === "read",
      );
      const json = JSON.stringify(input);
      if (Buffer.byteLength(json, "utf8") > 2 * 1024 * 1024)
        throw new ResourceError("LINEAR_CONTENT_TOO_LARGE", `linear://${workspace}`, "not-applied");
      const directory = await mkdtemp(path.join(tmpdir(), "pi-linear-operation-"));
      let dispatched = false;
      try {
        const file = path.join(directory, "input.json");
        await writeFile(file, json, { mode: 0o600 });
        signal?.throwIfAborted();
        dispatched = true;
        const output = await run(
          cwd,
          ["resources", "invoke", operation, "--workspace", workspace, "--input-file", file],
          signal,
        );
        let receipt: LinearOperationReceipt;
        try {
          const row = record(
            decodeAxiObject(output, "invocation", [
              "workspace",
              "operation",
              "effect",
              "data",
              "error",
              "targetId",
              "rateLimit",
            ]).invocation,
          );
          if (
            row.workspace !== workspace ||
            row.operation !== operation ||
            (row.effect !== "applied" &&
              row.effect !== "not-applied" &&
              row.effect !== "unknown") ||
            (row.error !== undefined &&
              (typeof row.error !== "string" || !/^LINEAR_[A-Z_]+$/u.test(row.error))) ||
            (row.data !== undefined && typeof row.data !== "string") ||
            (row.targetId !== undefined &&
              (typeof row.targetId !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
                  row.targetId,
                )))
          )
            throw new Error("LINEAR_INVALID_OPERATION_RECEIPT");
          const rateLimit =
            typeof row.rateLimit === "string" ? safeLinearRateLimitInfo(row.rateLimit) : undefined;
          receipt = {
            workspace,
            operation,
            effect: row.effect,
            ...(row.data === undefined ? {} : { data: JSON.parse(row.data) as unknown }),
            ...(row.error === undefined ? {} : { error: row.error }),
            ...(rateLimit ? { rateLimit } : {}),
            ...(row.targetId === undefined ? {} : { targetId: row.targetId }),
          };
          if (receipt.effect === "applied" && !Object.hasOwn(receipt, "data"))
            throw new Error("LINEAR_INVALID_OPERATION_RECEIPT");
        } catch {
          throw new ResourceError(
            "LINEAR_INVALID_OPERATION_RECEIPT",
            `linear://${workspace}`,
            readOnly ? "not-applied" : "unknown",
          );
        }
        return receipt;
      } catch (error) {
        if (error instanceof ResourceError) throw error;
        const code = safeCode(error);
        const stage = parseLinearResourceFailure(code)?.stage;
        const preflight = stage === "CAPABILITIES" || stage === "WORKSPACE";
        throw linearResourceError(
          code,
          `linear://${workspace}`,
          dispatched && !readOnly && !preflight ? "unknown" : "not-applied",
          linearErrorRateLimit(error),
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
