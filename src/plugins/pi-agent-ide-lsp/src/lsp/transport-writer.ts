import type { Writable } from "node:stream";
import { StreamMessageWriter, type Message } from "vscode-jsonrpc/node";

/**
 * Ends the connection on write failure instead of rejecting into JSON-RPC 9's
 * async Promise executor. The owner must dispose the connection so pending
 * requests reject; a failed transport must never look like a successful request.
 */
export class TransportWriter extends StreamMessageWriter {
  constructor(
    stream: Writable,
    private readonly fail: (error: unknown) => void,
  ) {
    super(stream);
  }

  override async write(message: Message): Promise<void> {
    try {
      await super.write(message);
    } catch (error) {
      this.fail(error);
    }
  }
}
