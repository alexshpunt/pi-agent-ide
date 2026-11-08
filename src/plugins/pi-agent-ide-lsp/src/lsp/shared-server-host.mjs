// @ts-check
// A detached process that runs one language server for every Pi session on this machine that
// attaches with the same configuration. shared-servers.ts starts it and describes the protocol.
// Plain JavaScript so it runs outside Pi's TypeScript loader.
import { readFileSync, statSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

import spawnProcess from "cross-spawn";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

import {
  configurationItems,
  LspFileWatchers,
  SHARED_SERVER_PROTOCOL,
} from "./server-request-handlers.mjs";

/**
 * @typedef {object} AttachRequest
 * @property {number} protocol
 * @property {string} key
 * @property {readonly string[]} command
 * @property {string} cwd
 * @property {Record<string, string | undefined>} env
 * @property {unknown} settings
 * @property {Record<string, unknown>} initialize Initialize parameters of the attaching client.
 * @property {number} lingerMs
 * @property {number} timeoutMs
 */

/**
 * @typedef {object} SessionDocument
 * @property {number} version Version the session uses for this document.
 * @property {string} text Text the session last synchronized.
 * @property {boolean} published Whether the session received diagnostics for this version.
 * @property {number} syncedAt When the session sent this text, to tell it from later writes to the file.
 */

/**
 * @typedef {object} Session
 * @property {net.Socket} socket
 * @property {import("vscode-jsonrpc/node").MessageConnection} connection
 * @property {Map<string, SessionDocument>} documents
 * @property {Set<CancellationTokenSource>} requests
 */

/**
 * @typedef {object} ServerDocument
 * @property {string} text Text the server currently has.
 * @property {number} version Version the server currently has.
 * @property {Set<Session>} holders Sessions that have the document open.
 * @property {{ version: number | undefined; current: number; diagnostics: unknown[] } | undefined} publication
 *   Latest push diagnostics and the server version that was current when they arrived.
 * @property {ReturnType<typeof setTimeout> | undefined} closeTimer Pending close after the last holder left.
 */

/**
 * @typedef {object} Server
 * @property {import("node:child_process").ChildProcess} process
 * @property {import("vscode-jsonrpc/node").MessageConnection} connection
 * @property {unknown} initializeResult
 */

const NO_SESSION_TIMEOUT_MS = 30_000;
/** A socket that refuses connections this long after it was created belongs to a dead host. */
const STALE_SOCKET_MS = 60_000;
/** Logs of failed hosts are kept this long for diagnosis. */
const FAILURE_LOG_MS = 24 * 60 * 60_000;
const DIAGNOSTICS = "textDocument/publishDiagnostics";
const SERVER_STATUS = "experimental/serverStatus";
/**
 * Keep a document open on the server this long after its last session closed it, never longer
 * than the server lingers. Sessions close a document after each operation and often reopen it at
 * once; closing and reopening would make the server analyze it again, and the clear it publishes
 * for the close could reach the reopened document before the new report.
 */
const DOCUMENT_CLOSE_DELAY_MS = 5_000;

const socketPath = process.argv[2] ?? "";
const key = process.argv[3] ?? "";
const logPath = process.argv[4] ?? "";
if (!socketPath || !key || !logPath) {
  process.exitCode = 2;
  throw new Error("Usage: shared-server-host.mjs <socket> <key> <log>");
}

/** @type {Set<Session>} */
const sessions = new Set();
/** @type {Map<string, ServerDocument>} */
const documents = new Map();
/** @type {Promise<Server> | undefined} */
let server;
/** Set once the server is initialized; notifications are written in the order they arrive. */
/** @type {Server | undefined} */
let running;
/** @type {LspFileWatchers | undefined} */
let fileWatchers;
let nextVersion = 0;
/** Set once the server versions its diagnostics; its unversioned pushes then describe closed documents. */
let versionedDiagnostics = false;
/**
 * Latest `experimental/serverStatus`; sessions that attach later receive it at once.
 * @type {unknown}
 */
let serverStatus;
/**
 * The server's dynamic registration of pull diagnostics; sessions that attach later receive it.
 * @type {{ id: string; method: string; registerOptions?: unknown } | undefined}
 */
let pullRegistration;
let lingerMs = 10 * 60_000;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let stopTimer = setTimeout(() => void stop(), NO_SESSION_TIMEOUT_MS);
let stopping = false;

const listener = net.createServer((socket) => void accept(socket));
await listen();
void sweep();
for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
  process.on(signal, () => void stop());
process.on("uncaughtException", () => void stop(1));
process.on("unhandledRejection", () => void stop(1));

/** Bind the socket; another live host for this key wins, and a stale socket file is replaced. */
async function listen() {
  try {
    await bind();
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EADDRINUSE") throw error;
    if (await reachable(socketPath)) process.exit(0);
    await rm(socketPath, { force: true });
    await bind();
  }
}

/**
 * Remove files of hosts that ended without cleanup, for example when they were killed. Only
 * old sockets are probed: a new host creates its socket file just before it listens.
 */
async function sweep() {
  const directory = path.dirname(logPath);
  const now = Date.now();
  for (const name of await readdir(directory).catch(() => [])) {
    const file = path.join(directory, name);
    if (file === socketPath || file === logPath) continue;
    const changed = await stat(file).then(
      (stats) => stats.mtimeMs,
      () => now,
    );
    if (name.endsWith(".log") && now - changed > FAILURE_LOG_MS) await rm(file, { force: true });
    if (name.endsWith(".sock") && now - changed > STALE_SOCKET_MS && !(await reachable(file)))
      await rm(file, { force: true });
  }
}

/** @returns {Promise<void>} */
function bind() {
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(socketPath, () => {
      listener.off("error", reject);
      resolve();
    });
  });
}

/**
 * @param {string} target
 * @returns {Promise<boolean>}
 */
function reachable(target) {
  return new Promise((resolve) => {
    const probe = net.connect(target);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/**
 * Read the one-line attach request, then speak LSP with the session on the same socket.
 * @param {net.Socket} socket
 */
async function accept(socket) {
  socket.on("error", () => void 0);
  /** @type {AttachRequest} */
  let attach;
  try {
    attach = /** @type {AttachRequest} */ (JSON.parse(await readLine(socket)));
  } catch {
    socket.destroy();
    return;
  }
  if (attach.protocol !== SHARED_SERVER_PROTOCOL || attach.key !== key) {
    socket.end(`${JSON.stringify({ error: "Shared language server configuration mismatch" })}\n`);
    return;
  }
  let started;
  try {
    started = await (server ??= startServer(attach));
    running = started;
  } catch (error) {
    socket.end(
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    void stop(1);
    return;
  }
  if (stopping || socket.destroyed) {
    socket.destroy();
    return;
  }
  lingerMs = attach.lingerMs;
  clearTimeout(stopTimer);
  stopTimer = undefined;
  const session = openSession(socket, started);
  socket.write(`${JSON.stringify({ pid: started.process.pid })}\n`);
  session.connection.listen();
  if (serverStatus !== undefined) notifySession(session, SERVER_STATUS, serverStatus);
  registerPull(session);
  // readLine paused the socket; a new data listener does not resume an explicitly paused stream.
  socket.resume();
}

/**
 * @param {net.Socket} socket
 * @returns {Promise<string>}
 */
function readLine(socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(10);
      if (end === -1) return;
      cleanup();
      socket.pause();
      if (end + 1 < buffered.length) socket.unshift(buffered.subarray(end + 1));
      resolve(buffered.subarray(0, end).toString("utf8"));
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("Session closed before attaching"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
  });
}

/**
 * Start and initialize the language server with the first session's configuration.
 * @param {AttachRequest} attach
 * @returns {Promise<Server>}
 */
async function startServer(attach) {
  const [command, ...args] = attach.command;
  if (!command) throw new Error("Shared language server has no command");
  const child = spawnProcess(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: attach.cwd,
    env: attach.env,
  });
  let stderr = "";
  // A server can exit before its last stderr output arrives; startup errors wait for it.
  const stderrEnded = new Promise((resolve) => {
    child.stderr?.once("end", resolve);
    child.stderr?.once("close", resolve);
  });
  /** @type {number | null | undefined} */
  let exitCode;
  const exited = new Promise((resolve) => {
    child.once("exit", (code) => {
      exitCode = code;
      resolve(undefined);
    });
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (/** @type {string} */ chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.stdin?.on("error", () => void 0);
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    // The server exited on its own. Record why and fail, so that the log stays for diagnosis; a
    // clean stop deletes it.
    void Promise.race([stderrEnded, new Promise((resolve) => setTimeout(resolve, 250))]).then(
      () => {
        const output = stderr.trim();
        process.stderr.write(
          `${new Date().toISOString()} ${command} exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}${output ? `:\n${output}` : ""}\n`,
        );
        void stop(1);
      },
    );
  });

  const connection = createMessageConnection(
    new StreamMessageReader(/** @type {import("node:stream").Readable} */ (child.stdout)),
    new StreamMessageWriter(/** @type {import("node:stream").Writable} */ (child.stdin)),
  );
  connection.onError(() => void 0);
  const watchers = new LspFileWatchers(
    attach.cwd,
    (change) =>
      void connection
        .sendNotification("workspace/didChangeWatchedFiles", { changes: [change] })
        .catch(() => void 0),
    () => void 0,
  );
  fileWatchers = watchers;
  connection.onRequest(
    "client/registerCapability",
    async (
      /** @type {{ registrations: { id: string; method: string; registerOptions?: { watchers?: import("./file-watchers.js").WatchPattern[] } }[] }} */ parameters,
    ) => {
      for (const registration of parameters.registrations) {
        if (registration.method === "workspace/didChangeConfiguration") continue;
        if (registration.method === "textDocument/diagnostic") {
          // Each session reads diagnostics itself, so each learns that it can pull them.
          pullRegistration = registration;
          for (const session of sessions) registerPull(session);
          continue;
        }
        if (registration.method !== "workspace/didChangeWatchedFiles")
          throw new Error(`Unsupported dynamic capability: ${registration.method}`);
        await watchers.register(registration.id, registration.registerOptions?.watchers ?? []);
      }
      return null;
    },
  );
  connection.onRequest(
    "client/unregisterCapability",
    (/** @type {{ unregisterations: { id: string }[] }} */ parameters) => {
      for (const registration of parameters.unregisterations) {
        if (registration.id === pullRegistration?.id) {
          pullRegistration = undefined;
          for (const session of sessions)
            void session.connection
              .sendRequest("client/unregisterCapability", { unregisterations: [registration] })
              .catch(() => void 0);
        } else watchers.unregister(registration.id);
      }
      return null;
    },
  );
  connection.onRequest("window/workDoneProgress/create", () => null);
  // A pull-diagnostic server asks for new pulls after results change; pyright exits when this
  // request fails. Each session pulls its own documents.
  connection.onRequest("workspace/diagnostic/refresh", () => {
    for (const session of sessions)
      void session.connection.sendRequest("workspace/diagnostic/refresh").catch(() => void 0);
    return null;
  });
  connection.onRequest(
    "workspace/configuration",
    (/** @type {{ items: { section?: string }[] }} */ parameters) =>
      configurationItems(attach.settings, parameters.items),
  );
  connection.onRequest(
    "workspace/workspaceFolders",
    () => attach.initialize.workspaceFolders ?? null,
  );
  connection.onNotification((method, parameters) => publishToSessions(method, parameters));
  connection.listen();

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeout;
  try {
    /** @type {unknown} */
    const initializeResult = await Promise.race([
      connection.sendRequest(/** @type {string} */ ("initialize"), {
        ...attach.initialize,
        processId: process.pid,
      }),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Shared language server initialize timed out")),
          attach.timeoutMs,
        );
      }),
      // A server that exits does not answer; its pending initialize would wait for the timeout.
      exited.then(() => {
        throw new Error("Shared language server exited during startup");
      }),
    ]);
    await connection.sendNotification("initialized", {});
    if (attach.settings !== undefined)
      await connection.sendNotification("workspace/didChangeConfiguration", {
        settings: attach.settings,
      });
    return { process: child, connection, initializeResult };
  } catch (error) {
    // A failed initialize write can precede the exit event and the server's last stderr output.
    await Promise.race([
      Promise.all([stderrEnded, exited]),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
    const detail = stderr.trim();
    const exit =
      exitCode === undefined
        ? ""
        : `exited during startup${exitCode === null ? "" : ` with code ${exitCode}`}`;
    if (!detail && !exit) throw error;
    throw new Error([exit, detail].filter(Boolean).join(": "), { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Route one session's LSP traffic to the shared server.
 * @param {net.Socket} socket
 * @param {Server} started
 * @returns {Session}
 */
function openSession(socket, started) {
  const connection = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  );
  /** @type {Session} */
  const session = { socket, connection, documents: new Map(), requests: new Set() };
  sessions.add(session);
  connection.onError(() => void 0);
  connection.onClose(() => detach(session));
  socket.once("close", () => detach(session));

  connection.onRequest("initialize", () => started.initializeResult);
  connection.onRequest("shutdown", () => {
    releaseDocuments(session);
    return null;
  });
  connection.onNotification("exit", () => {
    socket.end();
  });
  // The host initialized the server and serves settings itself.
  connection.onNotification("initialized", () => void 0);
  connection.onNotification("workspace/didChangeConfiguration", () => void 0);
  connection.onNotification(
    "textDocument/didOpen",
    (
      /** @type {{ textDocument: { uri: string; languageId: string; version: number; text: string } }} */ {
        textDocument,
      },
    ) => {
      const existing = documents.get(textDocument.uri);
      clearTimeout(existing?.closeTimer);
      if (existing) existing.closeTimer = undefined;
      else {
        const version = ++nextVersion;
        documents.set(textDocument.uri, {
          text: textDocument.text,
          version,
          holders: new Set(),
          publication: undefined,
          closeTimer: undefined,
        });
        notifyServer("textDocument/didOpen", { textDocument: { ...textDocument, version } });
      }
      session.documents.set(textDocument.uri, {
        version: textDocument.version,
        text: textDocument.text,
        published: false,
        syncedAt: Date.now(),
      });
      documents.get(textDocument.uri)?.holders.add(session);
      align(session, textDocument.uri);
    },
  );
  connection.onNotification(
    "textDocument/didChange",
    (
      /** @type {{ textDocument: { uri: string; version: number }; contentChanges: { text: string; range?: unknown }[] }} */ {
        textDocument,
        contentChanges,
      },
    ) => {
      const owned = session.documents.get(textDocument.uri);
      const text = contentChanges.at(-1)?.text;
      // LspClient always sends full text; ranges would make the shared text unknown.
      if (!owned || text === undefined || contentChanges.some((change) => change.range)) return;
      owned.version = textDocument.version;
      owned.text = text;
      owned.published = false;
      owned.syncedAt = Date.now();
      align(session, textDocument.uri);
    },
  );
  connection.onNotification(
    "textDocument/didClose",
    (/** @type {{ textDocument: { uri: string } }} */ { textDocument }) =>
      closeDocument(session, textDocument.uri),
  );
  connection.onNotification((method, parameters) => notifyServer(method, parameters));
  connection.onRequest(async (method, parameters, token) => {
    const uri = documentUriOf(parameters);
    if (uri) align(session, uri);
    // The server answers for the text it has now. Another session's text may replace it before
    // the answer arrives, so the versions are mapped as they were when the request was sent.
    const owned = uri === undefined ? undefined : session.documents.get(uri);
    const document = uri === undefined ? undefined : documents.get(uri);
    const sent =
      uri !== undefined && owned && document && document.text === owned.text
        ? { uri, server: document.version, session: owned.version }
        : undefined;
    const cancellation = new CancellationTokenSource();
    const forward = token.onCancellationRequested(() => cancellation.cancel());
    session.requests.add(cancellation);
    try {
      /** @type {unknown} */
      const result = await started.connection.sendRequest(method, parameters, cancellation.token);
      return sessionVersions(session, result, sent);
    } finally {
      forward.dispose();
      session.requests.delete(cancellation);
      cancellation.dispose();
    }
  });
  return session;
}

/**
 * Give the server this session's text before its request or after its change, then replay
 * diagnostics the server already published for that text.
 * @param {Session} session
 * @param {string} uri
 */
function align(session, uri) {
  const owned = session.documents.get(uri);
  const document = documents.get(uri);
  if (!owned || !document) return;
  if (document.text !== owned.text) {
    // Another process wrote the file after this session sent its copy, so the copy is older than
    // the file. Putting it back would make the server reparse and cancel the other sessions'
    // requests; that session catches up with its next request or edit. A copy sent after the
    // file's last write, such as an unsaved proposal, still reaches the server.
    if (olderThanFile(uri, document.text, owned)) return;
    document.text = owned.text;
    document.version = ++nextVersion;
    document.publication = undefined;
    notifyServer("textDocument/didChange", {
      textDocument: { uri, version: document.version },
      contentChanges: [{ text: owned.text }],
    });
    return;
  }
  const publication = document.publication;
  if (publication?.current !== document.version) return;
  owned.published = true;
  notifySession(session, DIAGNOSTICS, {
    uri,
    ...(publication.version !== undefined && { version: owned.version }),
    diagnostics: publication.diagnostics,
  });
}

/**
 * Whether the server has the text of the document's file and a session's copy predates the
 * file's last write. Documents that are not readable local files are never older.
 * @param {string} uri
 * @param {string} serverText
 * @param {{ text: string; syncedAt: number }} owned
 */
function olderThanFile(uri, serverText, owned) {
  if (!uri.startsWith("file:")) return false;
  try {
    const file = fileURLToPath(uri);
    return (
      statSync(file).mtimeMs > owned.syncedAt &&
      owned.text !== serverText &&
      readFileSync(file, "utf8") === serverText
    );
  } catch {
    return false;
  }
}

/**
 * After the server published for its current text, give it the text of another session that
 * still waits for diagnostics. Servers such as clangd publish nothing for a text that a newer
 * one replaced, so without this an earlier session would wait in vain.
 * @param {string} uri
 */
function serveWaitingSession(uri) {
  const document = documents.get(uri);
  if (!document) return;
  for (const session of document.holders) {
    const owned = session.documents.get(uri);
    // A copy older than the file is not served; see align.
    if (
      owned &&
      !owned.published &&
      owned.text !== document.text &&
      !olderThanFile(uri, document.text, owned)
    ) {
      align(session, uri);
      return;
    }
  }
}

/**
 * Deliver server notifications. Diagnostics of an open document reach only the sessions whose
 * text the server has, under their own document versions; others go to every session.
 * @param {string} method
 * @param {unknown} parameters
 */
function publishToSessions(method, parameters) {
  const publication = /** @type {{ uri?: unknown; version?: unknown; diagnostics?: unknown }} */ (
    parameters ?? {}
  );
  const document =
    method === DIAGNOSTICS && typeof publication.uri === "string"
      ? documents.get(publication.uri)
      : undefined;
  if (method === SERVER_STATUS) serverStatus = parameters;
  const version = typeof publication.version === "number" ? publication.version : undefined;
  if (method === DIAGNOSTICS && version !== undefined) versionedDiagnostics = true;
  if (!document || !Array.isArray(publication.diagnostics)) {
    for (const session of sessions) notifySession(session, method, parameters);
    return;
  }
  // Such a server omits the version only for a document it sees as closed, so an unversioned push
  // for an open document predates its latest didOpen, such as the clear for a close that a quick
  // reopen followed.
  if (version === undefined && versionedDiagnostics) return;
  if (version !== undefined && version !== document.version) return;
  document.publication = {
    version,
    current: document.version,
    diagnostics: publication.diagnostics,
  };
  for (const session of document.holders) {
    const owned = session.documents.get(/** @type {string} */ (publication.uri));
    if (owned?.text !== document.text) continue;
    owned.published = true;
    notifySession(session, DIAGNOSTICS, {
      ...publication,
      ...(version !== undefined && { version: owned.version }),
    });
  }
  serveWaitingSession(/** @type {string} */ (publication.uri));
}

/**
 * Report document versions in results, such as rename edits, in the session's numbering.
 * A version that is not the session's current text never matches one of its versions.
 * @param {Session} session
 * @param {unknown} value
 * @param {{ uri: string; server: number; session: number }} [sent] the requested
 *   document's server and session versions when the request was sent
 * @returns {unknown}
 */
function sessionVersions(session, value, sent) {
  if (Array.isArray(value)) return value.map((item) => sessionVersions(session, item, sent));
  if (typeof value !== "object" || value === null) return value;
  const mapped = Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, sessionVersions(session, item, sent)]),
  );
  const identifier = /** @type {{ textDocument?: { uri?: unknown; version?: unknown } }} */ (mapped)
    .textDocument;
  if (sent !== undefined && identifier?.uri === sent.uri && identifier.version === sent.server) {
    mapped.textDocument = { ...identifier, version: sent.session };
  } else if (typeof identifier?.uri === "string" && typeof identifier.version === "number") {
    const owned = session.documents.get(identifier.uri);
    const document = documents.get(identifier.uri);
    const current =
      owned && document && document.version === identifier.version && document.text === owned.text;
    mapped.textDocument = { ...identifier, version: current ? owned.version : -1 };
  }
  return mapped;
}

/** @param {unknown} parameters */
function documentUriOf(parameters) {
  const uri = /** @type {{ textDocument?: { uri?: unknown } } | undefined} */ (parameters)
    ?.textDocument?.uri;
  return typeof uri === "string" ? uri : undefined;
}

/**
 * @param {Session} session
 * @param {string} uri
 */
function closeDocument(session, uri) {
  session.documents.delete(uri);
  const document = documents.get(uri);
  if (!document) return;
  document.holders.delete(session);
  if (document.holders.size > 0) return;
  clearTimeout(document.closeTimer);
  document.closeTimer = setTimeout(
    () => {
      if (documents.get(uri) !== document || document.holders.size > 0) return;
      documents.delete(uri);
      notifyServer("textDocument/didClose", { textDocument: { uri } });
    },
    Math.min(lingerMs, DOCUMENT_CLOSE_DELAY_MS),
  );
}

/** @param {Session} session */
function releaseDocuments(session) {
  for (const uri of [...session.documents.keys()]) closeDocument(session, uri);
}

/** @param {Session} session */
function detach(session) {
  if (!sessions.delete(session)) return;
  for (const request of session.requests) request.cancel();
  releaseDocuments(session);
  session.connection.dispose();
  if (sessions.size === 0 && !stopping) {
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => void stop(), lingerMs);
  }
}

/**
 * @param {string} method
 * @param {unknown} parameters
 */
function notifyServer(method, parameters) {
  void running?.connection.sendNotification(method, parameters).catch(() => void 0);
}

/**
 * Tell a session that the server registered pull diagnostics.
 * @param {Session} session
 */
function registerPull(session) {
  if (pullRegistration === undefined) return;
  void session.connection
    .sendRequest("client/registerCapability", { registrations: [pullRegistration] })
    .catch(() => void 0);
}

/**
 * @param {Session} session
 * @param {string} method
 * @param {unknown} parameters
 */
function notifySession(session, method, parameters) {
  void session.connection.sendNotification(method, parameters).catch(() => void 0);
}

/**
 * Stop the server, disconnect every session and remove the socket.
 * @param {number} [exitCode]
 */
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(stopTimer);
  listener.close();
  // A new host may bind this path while the server shuts down.
  if (process.platform !== "win32") await rm(socketPath, { force: true }).catch(() => void 0);
  for (const session of sessions) session.socket.destroy();
  const started = await server?.catch(() => undefined);
  fileWatchers?.dispose();
  if (started && started.process.exitCode === null && started.process.signalCode === null) {
    const exited = new Promise((resolve) => started.process.once("exit", resolve));
    await Promise.race([
      started.connection
        .sendRequest("shutdown")
        .then(() => started.connection.sendNotification("exit"))
        .catch(() => void 0),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    started.process.kill("SIGTERM");
    const killed = setTimeout(() => started.process.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(killed);
  }
  if (exitCode === 0) await rm(logPath, { force: true }).catch(() => void 0);
  process.exit(exitCode);
}
