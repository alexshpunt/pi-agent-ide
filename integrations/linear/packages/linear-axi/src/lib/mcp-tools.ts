import { AxiError } from "#axi/args.ts";
import {
  asArrayOfUnknown,
  asRecord,
  type InputRecord,
  type McpResult,
  type Runtime,
} from "#axi/types.ts";
import { valueText } from "./value-text.ts";

export async function callAvailableTool(
  runtime: Runtime,
  candidates: readonly string[],
  args: InputRecord | ((tool: string) => InputRecord),
): Promise<McpResult> {
  const tools =
    typeof runtime.client.listTools === "function" ? await runtime.client.listTools() : [];
  const names = new Set(tools.map((tool) => tool.name));
  const preferred = candidates.find((candidate) => names.has(candidate));
  if ((names.size > 0 && preferred === undefined) || candidates.length === 0) {
    throw new ToolUnavailableError(candidates);
  }
  const first = preferred ?? candidates[0];
  const orderedCandidates = [first, ...candidates.filter((candidate) => candidate !== first)];
  let preferredError: unknown;
  for (const candidate of orderedCandidates) {
    try {
      return await runtime.client.callTool(
        candidate,
        typeof args === "function" ? args(candidate) : args,
      );
    } catch (error) {
      if (!isUnknownToolError(error)) throw error;
      preferredError ??= error;
    }
  }
  throw preferredError instanceof Error
    ? preferredError
    : new Error(valueText(preferredError), { cause: preferredError });
}

export function isUnknownToolError(error: unknown): boolean {
  const record = asRecord(error);
  if (record?.toolUnavailable) return true;
  const message = record?.message;
  return /unknown tool|tool .*not found|method not found|not found.*tool/iu.test(
    typeof message === "string" ? message : valueText(error),
  );
}

export function extractData(result: unknown): unknown {
  const response = asRecord(result);
  if (response?.structuredContent !== undefined) return response.structuredContent;
  const items = asArrayOfUnknown(response?.content);
  const text = asRecord(items?.find((item) => asRecord(item)?.type === "text"))?.text;
  if (typeof text === "string" && text) {
    try {
      const value: unknown = JSON.parse(text);
      return value;
    } catch {
      return { text };
    }
  }
  return result ?? {};
}

export function asArray(data: unknown): InputRecord[] {
  const array = asArrayOfUnknown(data);
  if (array) return objectRows(array);
  const record = asRecord(data);
  if (!record) return [];
  for (const key of [
    "issues",
    "projects",
    "teams",
    "users",
    "documents",
    "comments",
    "milestones",
    "cycles",
    "statuses",
    "labels",
    "nodes",
    "items",
    "data",
  ]) {
    const rows = asArrayOfUnknown(record[key]);
    if (rows) return objectRows(rows);
  }
  return [record];
}

function objectRows(rows: readonly unknown[]): InputRecord[] {
  return rows.map((value) => {
    const row = asRecord(value);
    if (!row) throw new Error("LINEAR_INVALID_RESPONSE");
    return row;
  });
}

export async function hasTool(runtime: Runtime, name: string): Promise<boolean> {
  if (typeof runtime.client.listTools !== "function") return false;
  const tools = await runtime.client.listTools();
  return tools.some((tool) => tool.name === name);
}

export function mutationData(result: unknown, help: string[]): unknown {
  const data = extractData(result);
  const record = asRecord(data);
  if (asRecord(result)?.isError) {
    const message =
      record?.message ?? record?.text ?? record?.error ?? "Linear MCP mutation failed";
    throw new AxiError("operational", valueText(message), help);
  }
  if (record && Object.keys(record).length === 1 && typeof record.text === "string") {
    throw new AxiError("operational", record.text, help);
  }
  return data;
}

class ToolUnavailableError extends Error {
  readonly toolUnavailable = true;

  constructor(candidates: readonly string[]) {
    super(`Linear MCP server does not expose ${candidates.join(" or ")}`);
  }
}
