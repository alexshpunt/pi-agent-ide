import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isResourceResolutionAttempt,
  type ResourceByteRange,
  type ResourceResolver,
} from "pi-agent-resource";

import type {
  ReadRequest,
  ReadResourceGuardRegistration,
  ReadToolResult,
} from "#src/api/tools/read.js";
import { failureResult } from "#src/core/tools/read/read-result.js";
import {
  READ_OUTPUT_MAX_BYTES,
  READ_OUTPUT_MAX_LINES,
} from "#src/core/tools/read/output-truncation.js";

// A row contains 16 bytes and at most 90 ASCII characters, including large offsets.
const DISPLAY_BUDGET =
  16 *
  Math.max(1, Math.min(READ_OUTPUT_MAX_LINES - 4, Math.floor((READ_OUTPUT_MAX_BYTES - 1024) / 90)));
type RawContext = { cwd: string; signal?: AbortSignal };
type RawGuard = { readonly registration: ReadResourceGuardRegistration };

/** Read original file or provider bytes, without conversion or source annotations. */
export async function readRaw(
  request: ReadRequest,
  context: RawContext,
  audience: "agent" | "script",
  guards: readonly RawGuard[] = [],
  resolvers: readonly ResourceResolver[] = [],
): Promise<ReadToolResult> {
  const requested = request.path ?? "";
  try {
    if ((request.views?.length ?? 0) > 0)
      throw new Error(
        "Raw byte reads do not accept views. Omit views for bytes, or read the file without raw: to use text views.",
      );
    const offset = request.offset ?? 0;
    const limit = request.limit;
    if (
      !Number.isSafeInteger(offset) ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    )
      throw new Error("Use an integer byte offset and a non-negative integer byte limit");
    const input = requested.slice(4);
    if (input.length === 0) throw new Error("Supply a file or byte resource after raw:");
    if (
      !input.startsWith("file://") &&
      (isProtocolSource(input) || isProtocolSource(context.cwd))
    ) {
      for (const resolver of resolvers) {
        context.signal?.throwIfAborted();
        const attempt = await resolver.tryResolve(input, { ...context, audience });
        if (!isResourceResolutionAttempt(attempt))
          throw new Error(`Resolver ${resolver.id} returned an invalid result`);
        if (attempt.kind === "not-handled") continue;
        if (attempt.kind === "failed") throw attempt.error;
        const resource = attempt.resource;
        const source = `raw:${resource.source}`;
        if (!resource.readBytes)
          throw new Error(`Resource ${resource.source} does not support original byte reads`);
        const blocked = await checkGuards(request, source, context, audience, guards);
        if (blocked) return blocked;
        context.signal?.throwIfAborted();
        const readLimit =
          audience === "script" ? limit : Math.min(limit ?? DISPLAY_BUDGET, DISPLAY_BUDGET);
        const range = await resource.readBytes(offset, readLimit, context);
        context.signal?.throwIfAborted();
        validateByteRange(range, offset, readLimit);
        return rawResult(source, range, limit);
      }
      throw new Error(`No byte resource resolver handled ${input}`);
    }
    const requestedFile = input.startsWith("file://")
      ? fileURLToPath(input)
      : path.resolve(context.cwd, input);
    const file = await realpath(requestedFile);
    const source = `raw:${file}`;
    const blocked = await checkGuards(request, source, context, audience, guards);
    if (blocked) return blocked;
    context.signal?.throwIfAborted();
    if (!(await stat(file)).isFile()) throw new Error("Raw reads require a regular file");
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Raw reads require a regular file");
      const start = Math.min(stat.size, Math.max(0, offset < 0 ? stat.size + offset : offset));
      const requestedLength = Math.min(limit ?? stat.size, stat.size - start);
      const length =
        audience === "script" ? requestedLength : Math.min(requestedLength, DISPLAY_BUDGET);
      const buffer = Buffer.alloc(length);
      let count = 0;
      while (count < length) {
        context.signal?.throwIfAborted();
        const chunk = await handle.read(buffer, count, length - count, start + count);
        if (chunk.bytesRead === 0) break;
        count += chunk.bytesRead;
      }
      context.signal?.throwIfAborted();
      return rawResult(
        source,
        { bytes: buffer.subarray(0, count), byteOffset: start, totalBytes: stat.size },
        limit,
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return failureResult({
      code: "READ_FAILED",
      source: requested,
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
}

function isProtocolSource(source: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(source) && !/^[a-z]:[\\/]/iu.test(source);
}

async function checkGuards(
  request: ReadRequest,
  source: string,
  context: RawContext,
  audience: "agent" | "script",
  guards: readonly RawGuard[],
): Promise<ReadToolResult | undefined> {
  for (const { registration } of guards) {
    try {
      const outcome = await registration.guard({
        requestedSource: request.path ?? "",
        resourceSource: source,
        resolvedBy: "raw",
        cwd: context.cwd,
        request,
        audience,
        ...(context.signal !== undefined && { signal: context.signal }),
      });
      if (outcome.kind === "rejected")
        return failureResult({
          code: "READ_FAILED",
          source,
          resolverId: "raw",
          message: `Read blocked by hook ${registration.id}: ${outcome.reason}`,
        });
    } catch (error) {
      return failureResult({
        code: "READ_FAILED",
        source,
        resolverId: "raw",
        message: `Read blocked because hook ${registration.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
  }
  return undefined;
}

function validateByteRange(
  range: ResourceByteRange,
  offset: number,
  limit: number | undefined,
): void {
  if (
    !(range.bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(range.totalBytes) ||
    range.totalBytes < 0 ||
    !Number.isSafeInteger(range.byteOffset) ||
    range.byteOffset !==
      Math.min(range.totalBytes, Math.max(0, offset < 0 ? range.totalBytes + offset : offset)) ||
    range.bytes.length > Math.min(limit ?? range.totalBytes, range.totalBytes - range.byteOffset)
  )
    throw new Error("Byte resource returned an invalid range");
}

function rawResult(
  source: string,
  range: ResourceByteRange,
  limit: number | undefined,
): ReadToolResult {
  const { bytes, byteOffset: start, totalBytes } = range;
  const count = bytes.length;
  const nextOffset = start + count;
  const requestedLength = Math.min(limit ?? totalBytes, totalBytes - start);
  const header = `${source}\nBytes ${start}..${nextOffset} (end exclusive), ${totalBytes} bytes total`;
  const rows = formatRawBytes(bytes, start);
  const continuation =
    nextOffset >= totalBytes
      ? ""
      : count < requestedLength
        ? `\n[Output limited. Read ${JSON.stringify(source)} with offset=${nextOffset} to continue.]`
        : `\nUse offset=${nextOffset} to continue in bytes.`;
  return {
    content: [{ type: "text", text: `${header}\n${rows}${continuation}` }],
    details: { source, resolvedBy: "raw", byteOffset: start, byteLength: count, totalBytes },
    script: {
      kind: "bytes",
      source,
      byteOffset: start,
      byteLength: count,
      totalBytes,
      bytes: Array.from(bytes),
      truncated: count < requestedLength,
    },
  };
}

/** Render exact byte values with absolute hexadecimal offsets and a printable ASCII preview. */
export function formatRawBytes(bytes: Uint8Array, offset: number): string {
  const rows: string[] = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const row = bytes.subarray(index, index + 16);
    const hex = Array.from(row, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(row, (byte) =>
      byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".",
    ).join("");
    rows.push(`${(offset + index).toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  |${ascii}|`);
  }
  return rows.join("\n");
}
