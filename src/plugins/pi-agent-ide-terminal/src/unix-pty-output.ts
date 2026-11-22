import { readSync } from "node:fs";
import { ReadStream } from "node:tty";
import type { IPty } from "node-pty";

// Enough to empty the PTY queue, but bounded in case a descendant keeps writing after shell exit.
const MAX_DRAIN_BYTES = 256 * 1024;
const DRAIN_CHUNK_BYTES = 4096;

/** Preserve pending output when node-pty forces the Unix PTY stream closed. */
export function preserveUnixPtyOutput(pty: IPty): void {
  // node-pty 1.2.0-beta.18 destroys this stream 200 ms after process exit if it has not closed.
  // Its public onExit fires after close, too late to consume any remaining output.
  const { _socket: socket, fd } = pty as IPty & { _socket?: unknown; fd?: number };
  if (!(socket instanceof ReadStream) || fd === undefined || fd < 0) return;

  const destroy = socket.destroy.bind(socket);
  socket.destroy = (error) => {
    try {
      if (!error && !socket.destroyed && !socket.readableEnded) drainOutput(socket, fd);
    } finally {
      destroy(error);
    }
    return socket;
  };
}

function drainOutput(socket: ReadStream, fd: number): void {
  // read() emits any data already buffered by Node, including when the stream is paused.
  socket.read();
  const chunk = Buffer.allocUnsafe(DRAIN_CHUNK_BYTES);
  for (let remaining = MAX_DRAIN_BYTES; remaining > 0;) {
    let size: number;
    try {
      // node-pty opens the Unix master as non-blocking. EOF, EIO and EAGAIN all end the drain.
      size = readSync(fd, chunk, 0, Math.min(chunk.length, remaining), null);
    } catch {
      break;
    }
    if (size === 0) break;
    // Use the same decoder and data event as ordinary reads, in the same byte order.
    socket.push(chunk.subarray(0, size));
    socket.read();
    remaining -= size;
  }
  socket.push(null);
  socket.read();
}
