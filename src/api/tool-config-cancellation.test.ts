import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { loadLayeredToolConfig } from "./tool-config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("pre-cancelled local configuration does not read or parse layers", async () => {
  const controller = new AbortController();
  const reason = new Error("Do not load local config");
  controller.abort(reason);
  const parse = vi.fn(() => ({}));
  const options = { includeGlobal: false, signal: controller.signal };
  await expect(
    loadLayeredToolConfig("/unused-cancelled-project", "lsp-servers", parse, options),
  ).rejects.toBe(reason);
  expect(parse).not.toHaveBeenCalled();
});

test("cancelling a pending native configuration read preserves its reason and allows retry", async () => {
  const base = path.resolve(".tmp/tool-config-cancellation");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "owned-"));
  directories.push(directory);
  const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    path.join(configDirectory, "lsp-servers.json"),
    `${" ".repeat(8 * 1024 * 1024)}{}`,
  );
  const controller = new AbortController();
  const reason = new Error("Cancel native config read");
  const parse = vi.fn(() => ({}));
  const options = { includeGlobal: false, signal: controller.signal };
  const pending = loadLayeredToolConfig(directory, "lsp-servers", parse, options);
  const observed = pending.catch((error: unknown) => error);
  controller.abort(reason);
  expect(await observed).toBe(reason);
  expect(parse).not.toHaveBeenCalled();
  await expect(
    loadLayeredToolConfig(directory, "lsp-servers", parse, { includeGlobal: false }),
  ).resolves.toMatchObject({ entries: [] });
  expect(parse).toHaveBeenCalledTimes(2);
});
