import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { startSshProcess, type SshProcessChannel } from "#src/backend/ssh-channel.js";
import { startSshFixture } from "./ssh-fixture.js";

/** Start a private abstract-socket X11 desktop and only its owned SSH application windows. */
export async function startSshVisionFixture(options: { xResource?: boolean } = {}) {
  const desktop = spawn(
    "/usr/bin/Xvfb",
    [
      "-displayfd",
      "1",
      "-screen",
      "0",
      "96x64x24",
      "-nolisten",
      "tcp",
      "-nolisten",
      "unix",
      ...(options.xResource === false ? ["-extension", "X-Resource"] : []),
    ],
    { stdio: "pipe" },
  );
  desktop.stderr.resume();
  const channels: SshProcessChannel[] = [];
  let fixture: Awaited<ReturnType<typeof startSshFixture>> | undefined;
  async function stop() {
    try {
      const settled = await Promise.allSettled(channels.map((channel) => channel.stop()));
      const failed = settled.filter(
        (item): item is PromiseRejectedResult => item.status === "rejected",
      );
      if (failed.length)
        throw new AggregateError(
          failed.map((item): unknown => item.reason),
          "Owned window cleanup failed",
        );
    } finally {
      try {
        await fixture?.stop();
      } finally {
        if (desktop.exitCode === null && desktop.signalCode === null) {
          const stopped = once(desktop, "exit");
          desktop.kill("SIGTERM");
          await stopped;
        }
      }
    }
  }
  try {
    const ready: unknown[] = await once(desktop.stdout, "data", {
      signal: AbortSignal.timeout(5_000),
    });
    fixture = await startSshFixture({}, { DISPLAY: `:${String(ready[0]).trim()}` });
    const target = {
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    };
    const registry = new SshBackendRegistry([target]);
    const script = await readFile(
      path.resolve("tests/integration/fixtures/vision-owner-window.py"),
      "utf8",
    );
    async function addWindow(
      left: string,
      color: string,
      width = "32",
      height = "24",
      claimedPid?: number,
      border = 0,
    ) {
      const channel = await startSshProcess(
        target,
        "python3",
        [
          "-c",
          script,
          left,
          color,
          width,
          height,
          claimedPid === undefined ? "" : String(claimedPid),
          String(border),
        ],
        target.workspace,
      );
      channels.push(channel);
      let diagnostic = "";
      channel.stderr.on("data", (chunk: Buffer) => {
        diagnostic += chunk.toString("utf8");
      });
      await Promise.race([
        once(channel.stdout, "data", { signal: AbortSignal.timeout(5_000) }),
        channel.completion.then(({ exitCode }) => {
          throw new Error(`Owned window exited ${exitCode}: ${diagnostic}`);
        }),
      ]);
      channel.stdout.resume();
      return channel;
    }
    await addWindow("4", "ff0000");
    await addWindow("48", "0000ff");
    const first = channels[0];
    if (!first) throw new Error("Missing owned window");
    return {
      root: fixture.root,
      target,
      registry,
      pid: first.pid,
      addWindow,
      scope: `ssh://fixture${fixture.workspace}`,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
