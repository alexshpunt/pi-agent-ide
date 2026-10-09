import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { LspClient } from "./client.js";

const remote = () =>
  new LspClient({
    serverId: "owner",
    rootUri: "ssh://alpha/srv/project",
    command: [process.execPath],
  });

test("document identities stay in their language server owner", () => {
  const client = remote();
  expect(client.toUri("src/café #1.ts")).toBe("ssh://alpha/srv/project/src/caf%C3%A9%20%231.ts");
  expect(client.toUri("ssh://alpha/srv/other.ts")).toBe("ssh://alpha/srv/other.ts");
  expect(() => client.toUri("ssh://beta/srv/project/input.ts")).toThrow("owner");
  expect(() => client.toUri("file:///srv/project/input.ts")).toThrow("owner");
});

test("a failed owned stop still waits for watcher cleanup and keeps the startup failure", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let watching: (() => void) | undefined;
  let release: (() => void) | undefined;
  const attached = new Promise<void>((resolve) => {
    watching = resolve;
  });
  const stopFailure = new Error("Owned transport stop failed");
  const watcherFailure = new Error("Owned watcher stop failed");
  const controller = new AbortController();
  const abandoned = new Error("Abandon owned initialize");
  const client = new LspClient({
    serverId: "cleanup",
    rootUri: "ssh://fixture/project",
    command: ["owned"],
    ownerTransport: {
      toServerUri: (uri) => uri,
      fromServerUri: (uri) => uri,
      start: () =>
        Promise.resolve({
          stdin,
          stdout,
          stderr,
          remote: { target: "fixture", pid: 123 },
          completion: new Promise<{ exitCode: number }>(() => undefined),
          stop: () => Promise.reject(stopFailure),
        }),
      fileWatchers() {
        watching?.();
        return {
          register: () => Promise.resolve(),
          unregister: () => Promise.resolve(),
          dispose: () =>
            new Promise<void>((_resolve, reject) => {
              release = () => reject(watcherFailure);
            }),
        };
      },
    },
  });
  let finished = false;
  const startup = client.start(controller.signal);
  const observed = startup.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  try {
    await attached;
    controller.abort(abandoned);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    release?.();
    await expect(startup).rejects.toMatchObject({
      name: "AggregateError",
      errors: [
        abandoned,
        expect.objectContaining({ name: "AggregateError", errors: [stopFailure, watcherFailure] }),
      ],
    });
  } finally {
    release?.();
    await observed;
    await client.shutdown().catch(() => undefined);
    for (const stream of [stdin, stdout, stderr]) stream.destroy();
  }
});

test("an SSH root without an owned process transport refuses before local spawn", async () => {
  const client = remote();
  try {
    await expect(client.start()).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    expect(client.pid).toBeNull();
  } finally {
    await client.shutdown();
  }
});

test("every shutdown caller waits for a cancelled owned startup to stop", async () => {
  let releaseReady: (() => void) | undefined;
  let releaseStop: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let stopping: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    stopping = resolve;
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const client = new LspClient({
    serverId: "owned",
    rootUri: "ssh://fixture/project",
    command: ["owned"],
    ownerTransport: {
      toServerUri: (uri) => uri,
      fromServerUri: (uri) => uri,
      async start() {
        entered?.();
        await new Promise<void>((resolve) => {
          releaseReady = resolve;
        });
        return {
          stdin,
          stdout,
          stderr,
          remote: { target: "fixture", pid: 123 },
          completion: Promise.resolve({ exitCode: 0 }),
          stop() {
            stopping?.();
            return new Promise<void>((resolve) => {
              releaseStop = resolve;
            });
          },
        };
      },
    },
  });
  const controller = new AbortController();
  const startup = client.start(controller.signal);
  const outcome = startup.then(
    () => "ready",
    (error: unknown) => error,
  );
  try {
    await started;
    controller.abort(new Error("Abandon startup"));
    releaseReady?.();
    await stopped;
    let finished = false;
    const concurrent = client.shutdown().then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    releaseStop?.();
    await concurrent;
    await expect(startup).rejects.toThrow("Abandon startup");
  } finally {
    releaseReady?.();
    releaseStop?.();
    await outcome;
    await client.shutdown();
    for (const stream of [stdin, stdout, stderr]) stream.destroy();
  }
});

test.each(["shutdown", "dispose"] as const)(
  "%s waits for a process that becomes ready after disposal",
  async (method) => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let stops = 0;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const client = new LspClient({
      serverId: "late",
      rootUri: "ssh://fixture/project",
      command: ["owned"],
      ownerTransport: {
        toServerUri: (uri) => uri,
        fromServerUri: (uri) => uri,
        async start() {
          entered?.();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {
            stdin,
            stdout,
            stderr,
            remote: { target: "fixture", pid: 123 },
            completion: Promise.resolve({ exitCode: 0 }),
            stop() {
              stops += 1;
              return Promise.resolve();
            },
          };
        },
      },
    });
    const controller = new AbortController();
    const startup = client.start(controller.signal);
    const outcome = startup.catch(() => undefined);
    try {
      await started;
      let finished = false;
      const shutdown = Promise.resolve(client[method]()).then(() => {
        finished = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      release?.();
      await shutdown;
      await expect(startup).rejects.toThrow("disposed");
      expect(stops).toBe(1);
      expect(client.ready).toBe(false);
    } finally {
      controller.abort(new Error("Test cleanup"));
      release?.();
      await outcome;
      await client.shutdown();
      for (const stream of [stdin, stdout, stderr]) stream.destroy();
    }
  },
);
