import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFormatter } from "./formatter.js";
import { FormatterCommandRegistry } from "./registry.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

test.each([false, true])(
  "reports a missing formatter separately from a failed command (configured=%s)",
  async (configured) => {
    const root = path.resolve(".agents/tmp/formatter-provenance");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    directories.push(cwd);
    const filePath = path.join(cwd, "example.fixture");
    await writeFile(filePath, "saved edit\n");
    const registry = FormatterCommandRegistry.fromConfig({
      version: 1,
      formatters: configured
        ? {
            wrapper: {
              extensions: [".fixture"],
              run: { command: [path.join(cwd, "missing-formatter"), "{file}"] },
              output: "in-place",
            },
          }
        : {},
    });
    vi.spyOn(FormatterCommandRegistry, "fromDirectory").mockResolvedValue(registry);
    expect(await createFormatter().format({ filePath }, { cwd })).toEqual(
      configured
        ? { ok: false, edits: 0, formatter: "missing-formatter" }
        : { ok: true, edits: 0, formatter: null },
    );
  },
);
