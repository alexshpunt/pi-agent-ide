import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ResourceError, type AgentContent, type ResourceResolver } from "pi-agent-ide/api/resource";
import { decodeAxiObject, runAxi } from "./axi.ts";
import { parseAssetAddress } from "./asset-address.ts";
import { convertAsset } from "./asset-content.ts";

/** Private files use shared converters without granting authority to a temporary path. */
export function createLinearAssetResolver(run: typeof runAxi = runAxi): ResourceResolver {
  return {
    id: "linear-asset",
    async tryResolve(source, context) {
      const address = parseAssetAddress(source);
      if (!address) return { kind: "not-handled" };
      let bytes: Buffer | undefined;
      const load = async (signal?: AbortSignal): Promise<Buffer> => {
        if (bytes) return bytes;
        const directory = await mkdtemp(path.join(tmpdir(), "pi-linear-asset-"));
        try {
          const file = path.join(directory, "asset.bin");
          const output = await run(
            context.cwd,
            [
              "assets",
              "download",
              "--workspace",
              address.workspace,
              "--url",
              address.url,
              "--output",
              file,
            ],
            signal,
          );
          const row = decodeAxiObject(output, "download", [
            "workspace",
            "url",
            "size",
            "sha256",
          ]).download;
          if ((await stat(file)).size > 25 * 1024 * 1024) throw new Error("LINEAR_ASSET_TOO_LARGE");
          const buffer = await readFile(file, { signal });
          if (
            !row ||
            typeof row !== "object" ||
            !("workspace" in row && "url" in row && "size" in row && "sha256" in row) ||
            row.workspace !== address.workspace ||
            row.url !== address.url ||
            row.size !== buffer.length ||
            buffer.length > 25 * 1024 * 1024 ||
            row.sha256 !== createHash("sha256").update(buffer).digest("hex")
          )
            throw new Error("LINEAR_ASSET_SNAPSHOT_UNVERIFIED");
          bytes = buffer;
          return buffer;
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      };
      return {
        kind: "resolved",
        resource: {
          source: address.source,
          link: address.url,
          async readBytes(offset, limit, operation) {
            const buffer = await load(operation.signal ?? context.signal);
            const start = Math.min(
              buffer.length,
              Math.max(0, offset < 0 ? buffer.length + offset : offset),
            );
            const end = start + Math.min(limit ?? buffer.length, buffer.length - start);
            return {
              bytes: buffer.subarray(start, end),
              byteOffset: start,
              totalBytes: buffer.length,
            };
          },
          async read(operation): Promise<AgentContent> {
            const signal = operation.signal ?? context.signal;
            try {
              const buffer = await load(signal);
              const converted = await convertAsset(address.source, buffer, signal);
              if (converted) return converted;
              let text: string | undefined;
              if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
                try {
                  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
                  if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoded))
                    text = decoded;
                } catch {
                  /* Binary or malformed UTF-8 is never invented text. */
                }
              }
              return [
                {
                  type: "text",
                  text:
                    text ??
                    `This binary/archive format is not extracted. Read raw:${address.source} for original bytes. No OCR or archive expansion was performed.`,
                },
              ];
            } catch (error) {
              signal?.throwIfAborted();
              const code =
                error instanceof Error && /^LINEAR_[A-Z_]+$/u.test(error.message)
                  ? error.message
                  : "LINEAR_ASSET_READ_FAILED";
              throw new ResourceError(code, address.source, "not-applied");
            }
          },
        },
      };
    },
  };
}
