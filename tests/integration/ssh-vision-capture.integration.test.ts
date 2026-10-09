import { createCanvas, loadImage } from "@napi-rs/canvas";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { captureSshFrame } from "#src/backend/vision-capture.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import * as processChannels from "#src/backend/ssh-channel.js";
import { startSshProcess } from "#src/backend/ssh-channel.js";
import { startSshFixture } from "./support/ssh-fixture.js";
import { startSshVisionFixture } from "./support/ssh-vision-fixture.js";

test("target capture keeps the selected window pixels separate from another fixture window", async () => {
  const fixture = await startSshVisionFixture();
  try {
    const [metadata] = await readSshProcessMetadata(fixture.registry, fixture.scope, fixture.pid);
    if (!metadata?.executable) throw new Error("No native window process identity");
    const source = `window:ssh://fixture/${fixture.pid}`;
    const request = {
      kind: "window" as const,
      pid: fixture.pid,
      identity: metadata.identity,
      executable: metadata.executable,
    };
    const frame = await captureSshFrame(fixture.registry, source, request);
    const image = await loadImage(frame);
    expect([image.width, image.height]).toEqual([32, 24]);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    expect([...context.getImageData(16, 12, 1, 1).data]).toEqual([255, 0, 0, 255]);
    const display = await loadImage(
      await captureSshFrame(fixture.registry, "display:ssh://fixture/#0", {
        kind: "display",
        index: 0,
      }),
    );
    expect([display.width, display.height]).toEqual([96, 64]);
    await expect(
      captureSshFrame(fixture.registry, source, {
        ...request,
        identity: metadata.identity.replace(/:\d+$/u, ":0"),
      }),
    ).rejects.toMatchObject({ code: "STALE_PROCESS", source });
    await expect(
      captureSshFrame(fixture.registry, source, {
        ...request,
        executable: "/not-the-native-executable",
      }),
    ).rejects.toMatchObject({ code: "STALE_PROCESS", source });
    await fixture.addWindow("4", "00ff00");
    await expect(captureSshFrame(fixture.registry, source, request)).rejects.toMatchObject({
      code: "WINDOW_OBSCURED",
      source,
    });
    const large = await fixture.addWindow("4", "00ff00", "4097", "4097");
    const [largeMetadata] = await readSshProcessMetadata(
      fixture.registry,
      fixture.scope,
      large.pid,
    );
    if (!largeMetadata?.executable) throw new Error("Missing large-window identity");
    await expect(
      captureSshFrame(fixture.registry, `window:ssh://fixture/${large.pid}`, {
        kind: "window",
        pid: large.pid,
        identity: largeMetadata.identity,
        executable: largeMetadata.executable,
      }),
    ).rejects.toMatchObject({ code: "PIXEL_LIMIT" });
  } finally {
    await fixture.stop();
  }
}, 30_000);

test.each(["cancel", "deadline"] as const)(
  "an in-flight frame %s reaps only its acquisition before returning",
  async (mode) => {
    const fixture = await startSshVisionFixture();
    const grabber = await startSshProcess(
      fixture.target,
      "python3",
      [
        "-c",
        await readFile(path.resolve("tests/integration/fixtures/vision-grab-server.py"), "utf8"),
      ],
      fixture.target.workspace,
    );
    grabber.stderr.resume();
    const start = processChannels.startSshProcess;
    const marker = path.join(fixture.target.workspace, "capture.pid");
    const interception = vi.spyOn(processChannels, "startSshProcess");
    const controller = new AbortController();
    let acquisitionPid: number | undefined;
    try {
      await once(grabber.stdout, "data", { signal: AbortSignal.timeout(5_000) });
      grabber.stdout.resume();
      const [metadata] = await readSshProcessMetadata(fixture.registry, fixture.scope, fixture.pid);
      if (!metadata?.executable) throw new Error("Missing selected window identity");
      interception.mockImplementationOnce((target, command, args, cwd, context) =>
        start(
          target,
          command,
          [
            "-c",
            `import os; open(${JSON.stringify(marker)}, "w").write(str(os.getpid()))\n${args[1]}`,
            ...args.slice(2),
          ],
          cwd,
          context,
        ),
      );
      const source = `window:ssh://fixture/${fixture.pid}`;
      const request = {
        kind: "window" as const,
        pid: fixture.pid,
        identity: metadata.identity,
        executable: metadata.executable,
      };
      const outcome = captureSshFrame(fixture.registry, source, request, controller.signal).then(
        () => undefined,
        (error: unknown) => error,
      );
      await expect
        .poll(
          async () => {
            try {
              acquisitionPid = Number(await readFile(marker, "utf8"));
              return Number.isSafeInteger(acquisitionPid) && acquisitionPid > 0;
            } catch {
              return false;
            }
          },
          { timeout: 5_000 },
        )
        .toBe(true);
      if (mode === "cancel") controller.abort(new Error("Cancel blocked native frame"));
      expect(await outcome).toMatchObject({
        code: mode === "cancel" ? "CANCELLED" : "TIMEOUT",
        source,
      });
      await expect(
        readSshProcessMetadata(fixture.registry, fixture.scope, acquisitionPid),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await readSshProcessMetadata(fixture.registry, fixture.scope, fixture.pid))[0]?.identity,
      ).toBe(metadata.identity);
      expect(
        (await readSshProcessMetadata(fixture.registry, fixture.scope, grabber.pid))[0]?.pid,
      ).toBe(grabber.pid);
      await grabber.stop();
      const image = await loadImage(await captureSshFrame(fixture.registry, source, request));
      expect([image.width, image.height]).toEqual([32, 24]);
    } finally {
      interception.mockRestore();
      controller.abort();
      try {
        await grabber.stop();
        if (acquisitionPid !== undefined) {
          await expect
            .poll(
              async () => {
                try {
                  await readSshProcessMetadata(fixture.registry, fixture.scope, acquisitionPid);
                  return false;
                } catch (error) {
                  return error instanceof Error && "code" in error && error.code === "ENOENT";
                }
              },
              { timeout: 12_000 },
            )
            .toBe(true);
        }
      } finally {
        await fixture.stop();
      }
    }
  },
  30_000,
);

test.each(["stdout", "stderr"] as const)(
  "a native frame %s overrun stops its producer",
  async (stream) => {
    const fixture = await startSshVisionFixture();
    const start = processChannels.startSshProcess;
    const interception = vi.spyOn(processChannels, "startSshProcess");
    const marker = path.join(fixture.target.workspace, "overrun.pid");
    try {
      const [metadata] = await readSshProcessMetadata(fixture.registry, fixture.scope, fixture.pid);
      if (!metadata?.executable) throw new Error("Missing selected window identity");
      interception.mockImplementationOnce((target, command, _args, cwd, context) =>
        start(
          target,
          command,
          [
            "-c",
            `import os, sys, time; open(${JSON.stringify(marker)}, "w").write(str(os.getpid())); sys.${stream}.buffer.write(b"x" * (20 * 1024 * 1024 + 1)); sys.${stream}.flush(); time.sleep(60)`,
          ],
          cwd,
          context,
        ),
      );
      const source = `window:ssh://fixture/${fixture.pid}`;
      await expect(
        captureSshFrame(fixture.registry, source, {
          kind: "window",
          pid: fixture.pid,
          identity: metadata.identity,
          executable: metadata.executable,
        }),
      ).rejects.toMatchObject({ code: "BYTE_LIMIT", source });
      const pid = Number(await readFile(marker, "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      await expect(
        readSshProcessMetadata(fixture.registry, fixture.scope, pid),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await readSshProcessMetadata(fixture.registry, fixture.scope, fixture.pid))[0]?.identity,
      ).toBe(metadata.identity);
    } finally {
      interception.mockRestore();
      await fixture.stop();
    }
  },
  20_000,
);

test("a foreign window cannot authorize capture by advertising another process PID", async () => {
  const fixture = await startSshVisionFixture();
  const child = await startSshProcess(
    fixture.target,
    "python3",
    ["-c", "import time; time.sleep(60)"],
    fixture.target.workspace,
  );
  child.stdout.resume();
  child.stderr.resume();
  try {
    await fixture.addWindow("4", "00ff00", "32", "24", child.pid);
    const [metadata] = await readSshProcessMetadata(fixture.registry, fixture.scope, child.pid);
    if (!metadata?.executable) throw new Error("No native decoy identity");
    const source = `window:ssh://fixture/${child.pid}`;
    await expect(
      captureSshFrame(fixture.registry, source, {
        kind: "window",
        pid: child.pid,
        identity: metadata.identity,
        executable: metadata.executable,
      }),
    ).rejects.toMatchObject({ code: "EACCES", source });
  } finally {
    try {
      await child.stop();
    } finally {
      await fixture.stop();
    }
  }
}, 15_000);
test.each([
  {
    name: "unavailable trusted X11 client identity",
    options: { xResource: false },
    code: "CAPABILITY_UNAVAILABLE",
  },
  { name: "an overlapping foreign window border", options: {}, code: "WINDOW_OBSCURED" },
])(
  "target capture refuses $name before returning pixels",
  async ({ options, code }) => {
    const fixture = await startSshVisionFixture(options);
    try {
      if (options.xResource !== false)
        await fixture.addWindow("32", "00ff00", "8", "24", undefined, 8);
      const [metadata] = await readSshProcessMetadata(fixture.registry, fixture.scope, fixture.pid);
      if (!metadata?.executable) throw new Error("No selected native window identity");
      const source = `window:ssh://fixture/${fixture.pid}`;
      await expect(
        captureSshFrame(fixture.registry, source, {
          kind: "window",
          pid: fixture.pid,
          identity: metadata.identity,
          executable: metadata.executable,
        }),
      ).rejects.toMatchObject({ code, source });
    } finally {
      await fixture.stop();
    }
  },
  15_000,
);
test("a headless target fails without sampling any controller desktop", async () => {
  const fixture = await startSshFixture();
  const target = {
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  };
  const registry = new SshBackendRegistry([target]);
  const child = await startSshProcess(
    target,
    "python3",
    ["-c", "import time; time.sleep(60)"],
    fixture.workspace,
  );
  child.stdout.resume();
  child.stderr.resume();
  const source = `window:ssh://fixture/${child.pid}`;
  try {
    const [metadata] = await readSshProcessMetadata(
      registry,
      `ssh://fixture${fixture.workspace}`,
      child.pid,
    );
    if (!metadata?.executable) throw new Error("Missing headless native identity");
    await expect(
      captureSshFrame(registry, source, {
        kind: "window",
        pid: child.pid,
        identity: metadata.identity,
        executable: metadata.executable,
      }),
    ).rejects.toMatchObject({ code: "DESKTOP_UNAVAILABLE", source, effect: "not-applied" });
    await expect(
      captureSshFrame(registry, "display:ssh://fixture/#0", { kind: "display", index: 0 }),
    ).rejects.toMatchObject({ code: "DESKTOP_UNAVAILABLE" });
    const controller = new AbortController();
    const reason = new Error("Cancel target frame");
    controller.abort(reason);
    await expect(
      captureSshFrame(
        registry,
        source,
        {
          kind: "window",
          pid: child.pid,
          identity: metadata.identity,
          executable: metadata.executable,
        },
        controller.signal,
      ),
    ).rejects.toBe(reason);
  } finally {
    try {
      await child.stop();
    } finally {
      await fixture.stop();
    }
  }
}, 15_000);
