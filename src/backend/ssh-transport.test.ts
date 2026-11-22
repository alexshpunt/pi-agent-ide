import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  bundlePython,
  neutralDirectory,
  sshBootstrapCommand,
  sshBootstrapInput,
  sshFailureCode,
  sshTransferProgram,
  sshWorkerBundle,
  WORKER_HANDSHAKE,
} from "./ssh-transport.ts";

test("the Windows file and transfer workers carry their primitives; Linux workers do not", async () => {
  for (const program of [
    await sshWorkerBundle("windows", "file"),
    await sshTransferProgram("windows"),
  ])
    expect(program).toContain('"ssh_windows_files"');
  expect(await sshWorkerBundle("windows", "channel")).not.toContain("ssh_windows_files");
  expect(await sshWorkerBundle("linux", "file")).not.toContain("ssh_windows_files");
  expect(await sshTransferProgram("linux")).not.toContain("ssh_windows_files");
});

test("every Windows worker source is valid Python", () => {
  const sources = [
    "ssh_windows_files.py",
    "ssh_worker_windows.py",
    "ssh-transfer-worker-windows.py",
  ].map((name) => fileURLToPath(new URL(name, import.meta.url)));
  for (const source of sources) {
    const result = spawnSync("python3", [
      "-c",
      "import sys;compile(open(sys.argv[1], encoding='utf8').read(), sys.argv[1], 'exec')",
      source,
    ]);
    expect(result.stderr.toString(), source).toBe("");
    expect(result.status, source).toBe(0);
  }
});

test("the neutral directory is the root of the target's drive", () => {
  expect(neutralDirectory({ workspace: "/root" })).toBe("/");
  expect(neutralDirectory({ os: "windows", workspace: "/D:/Users/name" })).toBe("/D:/");
});

test("exit status alone cannot diagnose a missing remote Python dependency", () => {
  expect(sshFailureCode(127, "")).toBe("TRANSPORT_FAILED");
  expect(sshFailureCode(127, "remote worker stopped")).toBe("TRANSPORT_FAILED");
  expect(sshFailureCode(127, "bash: line 1: python3: command not found\n")).toBe(
    "DEPENDENCY_UNAVAILABLE",
  );
  expect(sshFailureCode(127, "sh: python3: not found\n")).toBe("DEPENDENCY_UNAVAILABLE");
});

test("each remote shell's missing-interpreter report names the dependency", () => {
  const reports: readonly (readonly [string, string])[] = [
    ["python3", "fish: Unknown command: python3\n"],
    ["py -3", "py : The term 'py' is not recognized as the name of a cmdlet, function\r\n"],
    ["py -3", "'py' is not recognized as an internal or external command,\r\n"],
    [
      "python",
      "Python was not found; run without arguments to install from the Microsoft Store\r\n",
    ],
  ];
  for (const [interpreter, stderr] of reports)
    expect(sshFailureCode(1, stderr, interpreter)).toBe("DEPENDENCY_UNAVAILABLE");
});

test("profile errors and OpenSSH failures are not a missing interpreter", () => {
  const profile =
    "oh-my-posh : The term 'oh-my-posh' is not recognized as the name of a cmdlet\r\n";
  expect(sshFailureCode(1, profile, "py -3")).toBe("TRANSPORT_FAILED");
  expect(sshFailureCode(255, "bash: python3: command not found\n")).toBe("TRANSPORT_FAILED");
  expect(sshFailureCode(255, "user@host: Permission denied (publickey).\n")).toBe("AUTH_FAILED");
});

/** Run the real bootstrap through /bin/sh, as a remote login shell would. */
function bootstrap(os: "linux" | "windows", program: string, request = "") {
  const result = spawnSync("/bin/sh", ["-c", sshBootstrapCommand("python3")], {
    input: Buffer.concat([sshBootstrapInput(os, program), Buffer.from(request)]),
  });
  const stdout = result.stdout.toString("utf8");
  const start = stdout.indexOf(WORKER_HANDSHAKE);
  const end = stdout.indexOf("\n", start);
  return {
    report: JSON.parse(stdout.slice(start + WORKER_HANDSHAKE.length, end)) as unknown,
    output: stdout.slice(end + 1),
  };
}

test("the bootstrap runs a bundled program and leaves later stdin to it", () => {
  const program = bundlePython(
    "import sys, helper\nsys.stdout.write(helper.shout(sys.stdin.read()))",
    { helper: "def shout(text):\n    return text.upper()\n" },
  );
  expect(bootstrap("linux", program, "request bytes")).toEqual({
    report: { platform: "linux", accepted: true },
    output: "REQUEST BYTES",
  });
});

test("the bootstrap refuses to run a program on an undeclared platform", () => {
  expect(bootstrap("windows", "print('ran')")).toEqual({
    report: { platform: "linux", accepted: false },
    output: "",
  });
});
