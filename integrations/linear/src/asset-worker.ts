import { parentPort, type MessagePort } from "node:worker_threads";
import { createJiti } from "jiti";
import type { AgentContent } from "pi-agent-ide/api/resource";
import type * as ContentApi from "pi-agent-ide/api/content";

const port = parentPort;
if (port === null) throw new Error("Asset converter requires a worker thread");

// Load the public source SDK, but keep PDF.js API and worker in their native package graph.
const sdk = createJiti(import.meta.url, {
  nativeModules: ["pdfjs-dist", "@earendil-works/pi-coding-agent"],
});
// The converters' module graph includes the whole Pi package and takes seconds to load, so
// one worker loads it once and converts every file it is sent, one at a time.
const converters = sdk
  .import<typeof ContentApi>("pi-agent-ide/api/content")
  .then(({ createPdfContentConverter, createImageContentConverter }) => [
    createPdfContentConverter(),
    createImageContentConverter(),
  ]);
converters.catch(() => {});

export interface AssetConversionRequest {
  readonly id: number;
  readonly source: string;
  readonly bytes: Uint8Array;
}

async function convert(source: string, bytes: Uint8Array): Promise<AgentContent | undefined> {
  const input = { source, bytes };
  for (const converter of await converters) {
    const result = await converter.tryConvert(input, {});
    if (result.kind === "failed") throw new Error("unsupported format");
    if (result.kind === "converted") {
      if (Buffer.byteLength(JSON.stringify(result.content)) > 25 * 1024 * 1024)
        throw new Error("converted content exceeds the budget");
      return result.content;
    }
  }
  return undefined;
}

async function processRequest(
  port: MessagePort,
  { id, source, bytes }: AssetConversionRequest,
): Promise<void> {
  try {
    port.postMessage({ id, ok: true, content: await convert(source, bytes) }, []);
  } catch {
    // No parser internals, local paths or private content in errors.
    port.postMessage({ id, ok: false }, []);
  }
}

port.on("message", (request: AssetConversionRequest) => {
  void processRequest(port, request);
});
