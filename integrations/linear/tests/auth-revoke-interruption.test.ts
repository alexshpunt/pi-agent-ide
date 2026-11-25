import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { createAuthRunner, type AuthStatus } from "#linear/auth-process.ts";

// Each test starts a real child that cold-loads the backend's TypeScript, which takes seconds
// on a loaded machine, and the timeout case also waits out the runner's own 30 s limit.
const CHILD_READY_MS = 30_000;
const LOADED_TEST_MS = 90_000;

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "linear-revoke-interruption-"));
  roots.push(root);
  const store = path.join(root, "connection.json");
  const marker = path.join(root, "dispatched");
  const entry = path.join(root, "cli.mjs");
  const source = pathToFileURL(path.resolve("packages/linear-axi/src/managed-connection.ts")).href;
  // Keep the backend in its own TypeScript project, just like the real child process.
  const { ManagedConnection } = (await import(source)) as {
    ManagedConnection: new (options: { env: NodeJS.ProcessEnv; fetchImpl: typeof fetch }) => {
      importCredential(input: { type: "oauth"; token: string }): Promise<AuthStatus>;
      logout(): Promise<AuthStatus>;
      status(): Promise<AuthStatus>;
    };
  };
  await writeFile(
    entry,
    `import {writeFileSync} from 'node:fs';
    import {ManagedConnection} from ${JSON.stringify(source)};
    const connection=new ManagedConnection({env:process.env,fetchImpl:async()=>{
      writeFileSync(${JSON.stringify(marker)},'dispatched');
      return new Promise(()=>{setInterval(()=>{},1000)});
    }});
    try{console.log(JSON.stringify(await connection.revoke()))}
    catch(error){console.log(JSON.stringify({event:'error',error:error.message}));process.exitCode=1}`,
  );
  vi.stubEnv("LINEAR_AXI_CONNECTION_FILE", store);
  const connection = new ManagedConnection({
    env: { LINEAR_AXI_CONNECTION_FILE: store },
    fetchImpl: async (_url, options) => {
      const id =
        new Headers(options?.headers).get("authorization") === "Bearer fixture-b" ? "b" : "a";
      return Response.json({
        data: {
          viewer: {
            id,
            name: id,
            organization: { id: "workspace", name: "Example", urlKey: "example" },
          },
        },
      });
    },
  });
  const selected = await connection.importCredential({ type: "oauth", token: "fixture-a" });
  return {
    root,
    connection,
    epoch: selected.epoch,
    run: createAuthRunner(async () => entry),
    ready: () =>
      vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("dispatched"), {
        timeout: CHILD_READY_MS,
      }),
  };
}

test.each(["cancel", "timeout"] as const)(
  "%s after revoke dispatch keeps an unknown outcome and retires A",
  async (mode) => {
    const f = await fixture();
    const controller = new AbortController();
    const outcome = f
      .run(f.root, ["revoke"], { signal: controller.signal, expectedEpoch: f.epoch })
      .then(
        () => "unexpected success",
        (error: Error) => error.message,
      );
    try {
      await f.ready();
      const during = await f.connection.status();
      if (mode === "cancel") controller.abort();
      expect(await outcome).toBe("LINEAR_AUTH_REVOKE_UNKNOWN");
      expect(during.state).toBe("signed-out");
      expect((await f.connection.status()).state).toBe("signed-out");
    } finally {
      controller.abort();
      await outcome;
    }
  },
  LOADED_TEST_MS,
);

test(
  "cancelling A's dispatched revoke cannot retire replacement B",
  { timeout: LOADED_TEST_MS },
  async () => {
    const f = await fixture();
    const controller = new AbortController();
    const outcome = f
      .run(f.root, ["revoke"], { signal: controller.signal, expectedEpoch: f.epoch })
      .then(
        () => "unexpected success",
        (error: Error) => error.message,
      );
    try {
      await f.ready();
      await f.connection.logout();
      const replacement = await f.connection.importCredential({
        type: "oauth",
        token: "fixture-b",
      });
      controller.abort();
      expect(await outcome).toBe("LINEAR_AUTH_REVOKE_UNKNOWN");
      expect(await f.connection.status()).toMatchObject({
        state: "connected",
        epoch: replacement.epoch,
        identity: { id: "b" },
      });
    } finally {
      controller.abort();
      await outcome;
    }
  },
);
