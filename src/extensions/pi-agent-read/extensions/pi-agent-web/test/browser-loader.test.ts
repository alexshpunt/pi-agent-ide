import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import {
  createSystemBrowserHtmlLoader,
  resolveSystemBrowserExecutable,
} from "#src/browser-loader.js";

test("finds Chromium on PATH", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-agent-web-browser-"));
  const executable = path.join(directory, "chromium");

  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    await expect(resolveSystemBrowserExecutable("", { PATH: directory })).resolves.toBe(executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports an invalid configured browser path", async () => {
  await expect(
    resolveSystemBrowserExecutable("/missing/pi-agent-browser", { PATH: "" }),
  ).rejects.toThrow("PI_AGENT_IDE_BROWSER_PATH is not executable");
});

test("bounds browser startup by the requested timeout", async () => {
  const root = path.resolve(".agents/tmp/browser-startup-timeout");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "case-"));
  const executable = path.join(directory, "chromium");
  try {
    // Stay alive without opening a browser connection. Playwright owns cleanup.
    await writeFile(executable, "#!/bin/sh\nexec sleep 60\n");
    await chmod(executable, 0o755);
    const loader = createSystemBrowserHtmlLoader({ executablePath: executable });
    await expect(
      loader.load(new URL("http://127.0.0.1"), { timeoutMs: 200 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 5_000);
