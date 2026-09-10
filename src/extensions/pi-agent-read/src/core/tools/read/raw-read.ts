import { open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ReadRequest, ReadToolResult } from "#src/api/tools/read.js";
import { failureResult } from "#src/core/tools/read/read-result.js";
import {
  READ_OUTPUT_MAX_BYTES,
  READ_OUTPUT_MAX_LINES,
} from "#src/core/tools/read/output-truncation.js";

/** Read original local file bytes, without text conversion or source annotations. */
export async function readRaw(
  request: ReadRequest,
  context: { cwd: string; signal?: AbortSignal },
  audience: "agent" | "script",
): Promise<ReadToolResult> {
  const requested = request.path ?? "";
  try {
    if ((request.views?.length ?? 0) > 0)
      throw new Error("Raw byte reads do not accept text views");
    const offset = request.offset ?? 0;
    const limit = request.limit;
    if (
      !Number.isSafeInteger(offset) ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    )
      throw new Error("Use an integer byte offset and a non-negative integer byte limit");
    const input = requested.slice(4);
    if (input.length === 0) throw new Error("Supply a local file after raw:");
    const file = input.startsWith("file://")
      ? fileURLToPath(input)
      : path.resolve(context.cwd, input);
    context.signal?.throwIfAborted();
    if (!(await stat(file)).isFile()) throw new Error("Raw reads require a regular file");
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Raw reads require a regular file");
      const start = Math.min(stat.size, Math.max(0, offset < 0 ? stat.size + offset : offset));
      const requestedLength = Math.min(limit ?? stat.size, stat.size - start);
      // A row contains 16 bytes and at most 90 ASCII characters, including large offsets.
      const displayBudget =
        16 *
        Math.max(
          1,
          Math.min(READ_OUTPUT_MAX_LINES - 4, Math.floor((READ_OUTPUT_MAX_BYTES - 1024) / 90)),
        );
      const length =
        audience === "script" ? requestedLength : Math.min(requestedLength, displayBudget);
      const buffer = Buffer.alloc(length);
      let count = 0;
      while (count < length) {
        context.signal?.throwIfAborted();
        const chunk = await handle.read(buffer, count, length - count, start + count);
        if (chunk.bytesRead === 0) break;
        count += chunk.bytesRead;
      }
      context.signal?.throwIfAborted();
      const bytes = buffer.subarray(0, count);
      const source = `raw:${file}`;
      const nextOffset = start + count;
      const hasMore = nextOffset < stat.size;
      const header = `${source}\nBytes ${start}..${nextOffset} (end exclusive), ${stat.size} bytes total`;
      const rows = formatRawBytes(bytes, start);
      const continuation = hasMore ? `\nUse offset=${nextOffset} to continue in bytes.` : "";
      return {
        content: [{ type: "text", text: `${header}\n${rows}${continuation}` }],
        details: {
          source,
          resolvedBy: "raw",
          byteOffset: start,
          byteLength: count,
          totalBytes: stat.size,
        },
        ...(audience === "script" && {
          script: {
            kind: "bytes" as const,
            source,
            byteOffset: start,
            byteLength: count,
            totalBytes: stat.size,
            bytes: Array.from(bytes),
          },
        }),
      };
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
