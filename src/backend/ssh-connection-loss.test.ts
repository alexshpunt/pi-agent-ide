import { expect, test } from "vitest";
import {
  describeSshConnectionLoss,
  sshAuthenticated,
  sshConnectionLossReason,
  sshConnectionLossTransient,
  sshMasterConnectionLossReason,
} from "./ssh-connection-loss.ts";
import { SshBackendError } from "./ssh.ts";

test("OpenSSH's own report of how a connection ended is classified", () => {
  const reports = [
    ["keepalive-timeout", "Timeout, server zinpc-win not responding.\r\n"],
    ["reset", "Read from remote host zinpc-win: Connection reset by peer\n"],
    ["reset", "kex_exchange_identification: read: Connection reset by peer\n"],
    ["closed-by-target", "Connection closed by 100.86.50.97 port 2200\n"],
    ["closed-by-target", "Connection to zinpc-win closed by remote host.\n"],
    ["broken-pipe", "client_loop: send disconnect: Broken pipe\n"],
    ["timed-out", "ssh: connect to host 100.86.50.97 port 2200: Connection timed out\n"],
    ["refused", "ssh: connect to host 127.0.0.1 port 22: Connection refused\n"],
    ["unreachable", "ssh: connect to host 10.0.0.9 port 22: No route to host\n"],
    ["unresolved", "ssh: Could not resolve hostname nowhere: Name or service not known\n"],
  ] as const;
  for (const [reason, stderr] of reports)
    expect(sshConnectionLossReason(255, stderr), stderr).toBe(reason);
});

test("the last OpenSSH report wins over earlier remote shell noise", () => {
  const stderr = [
    "profile: Connection refused by the license server",
    'Authenticated to zinpc-win ([100.86.50.97]:2200) using "publickey".',
    "Connection to zinpc-win closed by remote host.",
    "Transferred: sent 4096, received 8192 bytes, in 163.2 seconds",
  ].join("\n");
  expect(sshConnectionLossReason(255, stderr)).toBe("closed-by-target");
  expect(sshConnectionLossReason(255, "")).toBe("unexplained");
  expect(sshConnectionLossReason(null, "")).toBe("signal");
});

test("a master's log explains a connection the target closed without saying so", () => {
  const authenticated = 'Authenticated to 127.0.0.1 ([127.0.0.1]:2200) using "publickey".\r\n';
  const ended = "Transferred: sent 22892, received 3760 bytes, in 1.7 seconds\r\n";
  expect(sshMasterConnectionLossReason(authenticated + ended)).toBe("closed-by-target");
  expect(
    sshMasterConnectionLossReason(
      `${authenticated}Timeout, server zinpc-win not responding.\r\n${ended}`,
    ),
  ).toBe("keepalive-timeout");
  // A master that still runs has not ended its connection.
  expect(sshMasterConnectionLossReason(authenticated)).toBe("unexplained");
  expect(sshMasterConnectionLossReason("")).toBe("unexplained");
});

test("only losses the network can clear are worth another attempt", () => {
  for (const reason of ["keepalive-timeout", "reset", "closed-by-target", "timed-out"] as const)
    expect(sshConnectionLossTransient(reason), reason).toBe(true);
  for (const reason of ["refused", "unresolved", "unexplained", "signal"] as const)
    expect(sshConnectionLossTransient(reason), reason).toBe(false);
});

test("authentication is recognized only from OpenSSH's own line", () => {
  expect(sshAuthenticated('Authenticated to host ([10.0.0.1]:22) using "publickey".\n')).toBe(true);
  expect(sshAuthenticated("Authenticated to host (via proxy).\r\n")).toBe(true);
  expect(sshAuthenticated("kex_exchange_identification: Connection closed by remote host\n")).toBe(
    false,
  );
  expect(sshAuthenticated("echo Authenticated to nowhere\n")).toBe(false);
});

test("a lost connection says what happened, when, and how long the target was silent", () => {
  expect(
    describeSshConnectionLoss({
      reason: "reset",
      phase: "running",
      afterMs: 163_400,
      silentMs: 21_300,
    }),
  ).toBe(
    "the connection was reset (by the target or the network) while the command was running, 163 s after the connection attempt began; nothing had arrived from the target for 21 s before that",
  );
  expect(
    describeSshConnectionLoss({ reason: "timed-out", phase: "connecting", afterMs: 19_912 }),
  ).toBe(
    "the network stopped delivering data (TCP timed out) while connecting, 20 s after the connection attempt began; nothing ran on the target",
  );
});

test("a backend failure with a lost connection keeps its code and adds the description", () => {
  const connection = { reason: "closed-by-target", phase: "starting", afterMs: 2500 } as const;
  const error = new SshBackendError("TRANSPORT_FAILED", "ssh://win/C:/Users/user", "unknown", {
    connection,
  });
  expect(error).toMatchObject({ code: "TRANSPORT_FAILED", effect: "unknown", connection });
  expect(error.message).toBe(
    "TRANSPORT_FAILED: ssh://win/C:/Users/user: the target closed the connection while the command was starting, 2.5 s after the connection attempt began",
  );
  expect(new SshBackendError("TIMEOUT", "ssh://win/C:/", "not-applied").message).toBe(
    "TIMEOUT: ssh://win/C:/",
  );
});
