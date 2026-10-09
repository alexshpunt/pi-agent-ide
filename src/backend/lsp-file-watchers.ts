import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
  LspFileWatcherSubscriptions,
  WatchPattern,
  WatchedFileChange,
} from "#src/plugins/pi-agent-ide-lsp/index.js";
import type { SshProcessChannel } from "./ssh-channel.js";
import type { SshBackendRegistry } from "./registry.js";
import { remoteLocation } from "./identity.js";
import { SshBackendError } from "./ssh.js";

const messageSchema = Type.Union([
  Type.Object({ kind: Type.Literal("ready") }),
  Type.Object({
    kind: Type.Literal("change"),
    path: Type.String(),
    type: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
  }),
  Type.Object({
    kind: Type.Literal("error"),
    code: Type.Union([
      Type.Literal("WATCH_FAILED"),
      Type.Literal("WATCH_LIMIT"),
      Type.Literal("WATCH_OVERFLOW"),
    ]),
  }),
]);
interface Registration {
  id: string;
  closed: boolean;
  channel?: SshProcessChannel;
  stopping?: Promise<void>;
  starting: Promise<void>;
}

function inside(root: string, source: string): boolean {
  const relative = path.posix.relative(root, source);
  return (
    relative === "" ||
    // Containment only; no parent-relative source is constructed.
    // eslint-disable-next-line repo/no-parent-paths
    (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative))
  );
}
/** Native SSH subscriptions with owner paths and explicit process cleanup. No controller watches. */
export function createSshLspFileWatchers(
  registry: SshBackendRegistry,
  rootUri: string,
  changed: (change: WatchedFileChange) => void,
  failed: (error: Error) => void,
): LspFileWatcherSubscriptions {
  const owner = registry.resolve(rootUri);
  if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", rootUri, "not-applied");
  let disposed = false;
  const registrations = new Map<string, Registration>();
  const pending = new Set<Registration>();
  const closed = (record: Registration) => disposed || record.closed;
  const release = (record: Registration): Promise<void> => {
    record.closed = true;
    if (record.channel) record.stopping ??= record.channel.stop().then(() => undefined);
    return record.stopping ?? Promise.resolve();
  };
  const subscriptions: LspFileWatcherSubscriptions = {
    async register(id, patterns) {
      if (disposed) throw new SshBackendError("WATCH_DISPOSED", rootUri, "not-applied");
      const bindings = patterns.map((pattern: WatchPattern) => {
        const glob = pattern.globPattern;
        const supplied =
          typeof glob === "string"
            ? rootUri
            : typeof glob.baseUri === "string"
              ? glob.baseUri
              : glob.baseUri.uri;
        const source = supplied.startsWith("file://")
          ? remoteLocation(owner.location.target, fileURLToPath(supplied)).source
          : supplied;
        const base = registry.resolve(source);
        if (!base || base.location.target !== owner.location.target)
          throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
        const kind = pattern.kind ?? 7;
        if (!Number.isInteger(kind) || kind < 0 || kind > 7)
          throw new TypeError("Invalid file watcher event mask");
        return {
          root: base.location.path,
          expression: typeof glob === "string" ? glob : glob.pattern,
          kind,
        };
      });
      if (bindings.length === 0) {
        await subscriptions.unregister(id);
        return;
      }
      const record: Registration = { id, closed: false, starting: Promise.resolve() };
      pending.add(record);
      record.starting = (async () => {
        const worker = await readFile(new URL("./file-watch-worker.py", import.meta.url), "utf8");
        if (closed(record)) throw new SshBackendError("WATCH_DISPOSED", rootUri, "not-applied");
        const channel = await owner.backend.startProcess(
          "python3",
          [
            "-u",
            "-c",
            worker,
            JSON.stringify([...new Set(bindings.map((binding) => binding.root))]),
          ],
          owner.location.path,
        );
        record.channel = channel;
        channel.stderr.resume();
        if (closed(record)) {
          await release(record);
          throw new SshBackendError("WATCH_DISPOSED", rootUri, "not-applied");
        }
        const lines = createInterface({ input: channel.stdout });
        let ready = false;
        let rejected = false;
        const startup = new Promise<void>((resolve, reject) => {
          const fail = (code: string) => {
            if (rejected || record.closed) return;
            rejected = true;
            const error = new SshBackendError(code, rootUri, "not-applied");
            if (ready) failed(error);
            else reject(error);
            void release(record).catch(failed);
          };
          lines.on("line", (line) => {
            if (record.closed) return;
            let message: unknown;
            try {
              message = JSON.parse(line);
            } catch {
              fail("INVALID_RESPONSE");
              return;
            }
            if (!Value.Check(messageSchema, message)) {
              fail("INVALID_RESPONSE");
              return;
            }
            if (message.kind === "ready") {
              ready = true;
              resolve();
              return;
            }
            if (message.kind === "error") {
              fail(message.code);
              return;
            }
            if (!ready) {
              fail("INVALID_RESPONSE");
              return;
            }
            if (registrations.get(id) !== record) return;
            const matches = bindings.some((binding) => {
              if (!inside(binding.root, message.path)) return false;
              const relative = path.posix.relative(binding.root, message.path);
              return (
                (binding.kind & (message.type === 1 ? 1 : message.type === 2 ? 2 : 4)) !== 0 &&
                path.matchesGlob(
                  path.posix.isAbsolute(binding.expression) ? message.path : relative,
                  binding.expression,
                )
              );
            });
            if (matches)
              changed({
                uri: remoteLocation(owner.location.target, message.path).source,
                type: message.type,
              });
          });
          void channel.completion.then(
            () => {
              lines.close();
              if (!ready) reject(new SshBackendError("WATCH_FAILED", rootUri, "not-applied"));
              else if (!record.closed) fail("WATCH_FAILED");
            },
            () => {
              lines.close();
              if (!ready) reject(new SshBackendError("WATCH_FAILED", rootUri, "not-applied"));
              else if (!record.closed) fail("WATCH_FAILED");
            },
          );
        });
        await startup;
        if (closed(record)) {
          await release(record);
          throw new SshBackendError("WATCH_DISPOSED", rootUri, "not-applied");
        }
        const previous = registrations.get(id);
        registrations.set(id, record);
        if (previous) await release(previous);
      })();
      try {
        await record.starting;
      } catch (error) {
        await release(record);
        throw error;
      } finally {
        pending.delete(record);
      }
    },
    async unregister(id) {
      const active = registrations.get(id);
      registrations.delete(id);
      const starting = [...pending].filter((record) => record.id === id);
      await Promise.all([...starting, ...(active ? [active] : [])].map(release));
      await Promise.allSettled(starting.map((record) => record.starting));
    },
    async dispose() {
      disposed = true;
      const ids = new Set([...registrations.keys(), ...[...pending].map((record) => record.id)]);
      await Promise.all([...ids].map((id) => subscriptions.unregister(id)));
    },
  };
  return subscriptions;
}
