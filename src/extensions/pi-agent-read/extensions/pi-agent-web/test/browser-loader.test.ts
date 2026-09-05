import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { resolveSystemBrowserExecutable } from "#src/browser-loader.js";

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
