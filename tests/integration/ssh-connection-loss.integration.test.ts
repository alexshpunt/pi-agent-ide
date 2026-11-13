import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { startSshCarrierFixture } from "#integration/support/ssh-carrier-fixture.ts";
import { describeSshConnectionLoss } from "#src/backend/ssh-connection-loss.ts";
import { SshBackend, SshBackendError } from "#src/backend/ssh.ts";

/** The code, the source and the description of the classified loss the error carries. */
function expectedMessage(error: SshBackendError): string {
  const connection = error.connection ?? expect.unreachable("no classified connection loss");
  return `TRANSPORT_FAILED: ${error.source}: ${describeSshConnectionLoss(connection)}`;
}

// The first connection to a target starts Pi's master for it. When the network closes that
// connection, the process connects directly, so its own attempts begin with the second connection.

test("a connection lost while connecting is retried and runs the command once", async () => {
  const fixture = await startSshCarrierFixture();
  try {
    const backend = new SshBackend(fixture.target);
    const marker = `${fixture.workspace}/runs.txt`;
    const before = fixture.acceptedConnections;
    fixture.closeNextConnections(2);
    const channel = await backend.startProcess(
      "python3",
      ["-c", "import sys; open(sys.argv[1], 'a').write('ran\\n'); print('done')", marker],
      fixture.workspace,
    );
    const chunks: Buffer[] = [];
    channel.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    channel.stderr.resume();
    await expect(channel.completion).resolves.toEqual({ exitCode: 0 });
    expect(Buffer.concat(chunks).toString("utf8")).toBe("done\n");
    expect(fixture.acceptedConnections - before).toBe(3);
    expect((await fixture.direct.read(marker)).bytes.toString("utf8")).toBe("ran\n");
  } finally {
    await fixture.stop();
  }
}, 30000);

test("connections that keep failing while connecting report the reason and no effect", async () => {
  const fixture = await startSshCarrierFixture();
  try {
    const backend = new SshBackend(fixture.target);
    const before = fixture.acceptedConnections;
    fixture.closeNextConnections(10);
    const failure = await backend
      .startProcess("python3", ["-c", "print('never')"], fixture.workspace)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SshBackendError);
    expect(failure).toMatchObject({
      code: "TRANSPORT_FAILED",
      effect: "not-applied",
      connection: { phase: "connecting" },
    });
    // Closing a socket with the client's unread banner resets it on some systems.
    expect(["closed-by-target", "reset"]).toContain(
      (failure as SshBackendError).connection?.reason,
    );
    expect((failure as SshBackendError).message).toBe(expectedMessage(failure as SshBackendError));
    expect((failure as SshBackendError).message).toContain("nothing ran on the target");
    // The master, the first direct attempt and two retries.
    expect(fixture.acceptedConnections - before).toBe(4);
  } finally {
    fixture.closeNextConnections(0);
    await fixture.stop();
  }
}, 30000);

test("a refused connection fails at once instead of waiting to reconnect", async () => {
  const fixture = await startSshCarrierFixture();
  try {
    const backend = new SshBackend(fixture.target);
    await fixture.refuseConnections();
    const started = performance.now();
    const failure = await backend
      .startProcess("python3", ["-c", "print('never')"], fixture.workspace)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SshBackendError);
    expect(failure).toMatchObject({
      code: "TRANSPORT_FAILED",
      effect: "not-applied",
      connection: { reason: "refused", phase: "connecting" },
    });
    // The first pause before a reconnection alone is one second.
    expect(performance.now() - started).toBeLessThan(1000);
  } finally {
    await fixture.stop();
  }
}, 30000);

test("cancelling while waiting to reconnect reports a cancellation, not the lost connection", async () => {
  const fixture = await startSshCarrierFixture();
  try {
    const backend = new SshBackend(fixture.target);
    const before = fixture.acceptedConnections;
    fixture.closeNextConnections(10);
    const controller = new AbortController();
    const pending = backend
      .startProcess("python3", ["-c", "print('never')"], fixture.workspace, {
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    // The proxy closes the master's and the first direct connection at once, so the abort lands
    // in the one-second pause before the reconnection, however long the client took to connect.
    while (fixture.acceptedConnections - before < 2) await delay(10);
    await delay(300);
    controller.abort();
    const failure = await pending;
    expect(failure).toBeInstanceOf(SshBackendError);
    expect(failure).toMatchObject({ code: "CANCELLED", effect: "not-applied" });
    expect(fixture.acceptedConnections - before).toBe(2);
  } finally {
    fixture.closeNextConnections(0);
    await fixture.stop();
  }
}, 30000);

test("a connection lost while the command runs says when and how long the target was silent", async () => {
  const fixture = await startSshCarrierFixture();
  try {
    const backend = new SshBackend(fixture.target);
    const channel = await backend.startProcess(
      "python3",
      ["-c", "import time; print('started', flush=True); time.sleep(30)"],
      fixture.workspace,
      { pty: { cols: 80, rows: 24 } },
    );
    channel.stderr.resume();
    await new Promise<void>((resolve) => channel.stdout.once("data", () => resolve()));
    channel.stdout.resume();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await fixture.dropConnections()).toBe(1);
    const failure = await channel.completion.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SshBackendError);
    const error = failure as SshBackendError;
    expect(error).toMatchObject({ code: "TRANSPORT_FAILED", effect: "unknown" });
    expect(error.connection).toMatchObject({ phase: "running" });
    // The process goes through Pi's master, whose log tells how the connection ended.
    expect(["closed-by-target", "reset"]).toContain(error.connection?.reason);
    expect(error.connection?.afterMs).toBeGreaterThanOrEqual(1500);
    expect(error.connection?.silentMs).toBeGreaterThanOrEqual(1400);
    expect(error.message).toBe(expectedMessage(error));
    expect(error.message).toContain("nothing had arrived from the target");
  } finally {
    await fixture.stop();
  }
}, 30000);
