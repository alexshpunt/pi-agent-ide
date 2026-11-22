import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import type * as FileOperationResolver from "#src/backend/file-operation-resolver.ts";
import type * as Registry from "#src/backend/registry.ts";
import { remoteLocation } from "#src/backend/identity.ts";
import { startSshFixture } from "#integration/support/ssh-fixture.ts";
import { sshTransferPolicy } from "#integration/support/ssh-transfer-policy.ts";

// Pi can load the extension from a checkout that is updated while a session runs (LPT-1418).
test("an SSH copy uses the backend code it loaded after the files change on disk", async () => {
  const fixture = await startSshFixture();
  // A private copy of the backend stands in for the checkout of a running Pi.
  const checkout = await mkdtemp(path.resolve(".tmp/loaded-code-"));
  const backend = path.join(checkout, "backend");
  try {
    await cp(path.resolve("src/backend"), backend, {
      recursive: true,
      filter: (source) => !source.endsWith(".test.ts"),
    });
    const load = async <T>(name: string) =>
      (await import(pathToFileURL(path.join(backend, name)).href)) as T;
    const { SshBackendRegistry } = await load<typeof Registry>("registry.ts");
    const { createSshFileOperationResolver } = await load<typeof FileOperationResolver>(
      "file-operation-resolver.ts",
    );
    const registry = new SshBackendRegistry([
      { id: "left", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const operate = createSshFileOperationResolver(registry);
    // The update replaces every worker and module after the session loaded them; any of them
    // read from disk from now on breaks the transfer.
    for (const entry of await readdir(backend, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(backend, entry.name);
      if (entry.name.endsWith(".py")) await writeFile(file, "raise SystemExit(97)\n");
      else if (/\.(?:ts|mjs)$/u.test(entry.name))
        await writeFile(file, 'throw new Error("read after the update");\n');
    }
    const bytes = randomBytes(9000);
    const remote = path.join(fixture.workspace, "source.bin");
    const local = path.join(fixture.root, "copy.bin");
    await writeFile(remote, bytes);
    await operate(
      "copy",
      { path: remoteLocation("left", remote).source, target: local },
      { cwd: fixture.root },
      sshTransferPolicy,
    );
    expect(await readFile(local)).toEqual(bytes);
  } finally {
    await rm(checkout, { recursive: true, force: true });
    await fixture.stop();
  }
}, 60000);
