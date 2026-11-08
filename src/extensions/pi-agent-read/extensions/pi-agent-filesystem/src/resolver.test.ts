import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ResourceError } from "pi-agent-resource";
import { afterEach, expect, test } from "vitest";

import { createFilesystemWriteResolver } from "./resolver.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const resolver = createFilesystemWriteResolver({
  convert: ({ bytes }) =>
    Promise.resolve([{ type: "text", text: Buffer.from(bytes).toString("utf8") }]),
});

async function openFile(filePath: string) {
  const attempt = await resolver.tryResolve(filePath, { cwd: path.dirname(filePath) });
  if (attempt.kind !== "resolved" || attempt.resource.write === undefined)
    throw new Error("not a writable file");
  return attempt.resource as typeof attempt.resource & {
    write: NonNullable<typeof attempt.resource.write>;
  };
}

test("a write refuses to replace a file another process changed after the read", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-agent-filesystem-"));
  directories.push(directory);
  const filePath = path.join(directory, "shared.txt");
  await writeFile(filePath, "first\n");
  const mine = await openFile(filePath);
  const theirs = await openFile(filePath);
  await mine.read?.({});
  await theirs.read?.({});

  await theirs.write([{ type: "text", text: "their edit\n" }], {});
  const refused = mine.write([{ type: "text", text: "my edit\n" }], {});

  await expect(refused).rejects.toBeInstanceOf(ResourceError);
  await expect(refused).rejects.toMatchObject({ code: "RESOURCE_CHANGED", effect: "not-applied" });
  expect(await readFile(filePath, "utf8")).toBe("their edit\n");
  // A second write from the same read continues from what this process wrote.
  await theirs.write([{ type: "text", text: "their second edit\n" }], {});
  expect(await readFile(filePath, "utf8")).toBe("their second edit\n");
});
