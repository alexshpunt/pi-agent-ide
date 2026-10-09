import { execFile } from "node:child_process";
import { mkdir, readFile, readlink, writeFile, symlink, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { sshTransferPolicy } from "#integration/support/ssh-transfer-policy.js";
import { createSshFileOperationResolver } from "#src/backend/file-operation-resolver.js";
import { SshBackendRegistry } from "#src/backend/registry.js";

const exec = promisify(execFile);

test("mixed object transfers keep the approved child version before streaming", async () => {
  const fixture = await startSshFixture();
  const local = path.join(fixture.root, "local");
  const source = path.join(local, "source");
  const destination = path.join(fixture.workspace, "destination");
  const child = path.join(destination, "data");
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const target = `ssh://fixture${destination}`;
  const owner = registry.resolve(target);
  if (owner === undefined) throw Error("Missing target owner");
  const inspect = owner.backend.lstat.bind(owner.backend);
  let changed = false;
  try {
    await mkdir(source, { recursive: true });
    await exec("git", ["init", "-q", local]);
    expect(
      (await owner.backend.execute("git", ["init", "-q", fixture.workspace], fixture.workspace))
        .exitCode,
    ).toBe(0);
    await mkdir(destination);
    await writeFile(path.join(source, "data"), "source bytes");
    await writeFile(child, "approved bytes");
    owner.backend.lstat = async (...args) => {
      const entry = await inspect(...args);
      if (args[0] === child && !changed) {
        changed = true;
        // The stream must not accept a newer snapshot after its approved leaf check.
        await writeFile(child, "external bytes");
      }
      return entry;
    };
    await expect(
      createSshFileOperationResolver(registry)(
        "copy",
        { path: source, target },
        { cwd: local },
        sshTransferPolicy,
      ),
    ).rejects.toMatchObject({ code: "TRANSFER_TARGET_CHANGED" });
    expect(changed).toBe(true);
    expect(await readFile(child, "utf8")).toBe("external bytes");
    expect(await readFile(path.join(source, "data"), "utf8")).toBe("source bytes");
  } finally {
    owner.backend.lstat = inspect;
    await fixture.stop();
  }
}, 60_000);

test.each(["same-target", "upload", "download", "targets"] as const)(
  "SSH object transfers preserve binary children and link objects through %s",
  async (route) => {
    const left = await startSshFixture();
    const right = await startSshFixture();
    const targets = [left, right].map((fixture, index) => ({
      id: index === 0 ? "left" : "right",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    }));
    const registry = new SshBackendRegistry(targets);
    const operate = createSshFileOperationResolver(registry);
    const local = path.join(left.root, "local");
    try {
      await mkdir(local);
      await exec("git", ["init", "-q", local]);
      for (const id of ["left", "right"]) {
        const owner = registry.resolve(
          `ssh://${id}${id === "left" ? left.workspace : right.workspace}`,
        );
        if (owner === undefined) throw Error("Missing fixture owner");
        const setup = await owner.backend.execute(
          "git",
          ["init", "-q", owner.location.path],
          owner.location.path,
        );
        expect(setup.exitCode).toBe(0);
      }
      const sourceBase = route === "upload" ? local : left.workspace;
      const targetBase =
        route === "download" ? local : route === "targets" ? right.workspace : left.workspace;
      const sourceOwner = route === "upload" ? undefined : "left";
      const targetOwner = route === "download" ? undefined : route === "targets" ? "right" : "left";
      const sourcePath = path.join(sourceBase, "source");
      const targetPath = path.join(targetBase, "destination");
      const source = sourceOwner ? `ssh://${sourceOwner}${sourcePath}` : sourcePath;
      const target = targetOwner ? `ssh://${targetOwner}${targetPath}` : targetPath;
      const binary = Buffer.from([0, 255, 13, 10]);
      const seed = async (object: "directory" | "symlink") => {
        if (sourceOwner) {
          const owner = registry.resolve(source);
          if (!owner) throw Error("Missing source owner");
          const setup = await owner.backend.execute(
            "python3",
            [
              "-c",
              String.raw`
import os,pathlib,sys
p=pathlib.Path(sys.argv[1]); kind=sys.argv[2]
if kind=='directory':
 p.mkdir(); (p/'nested').mkdir(); (p/'nested'/'bytes').write_bytes(bytes([0,255,13,10]))
 (p/'broken').symlink_to('missing café'); (p/'binary-link').symlink_to(os.fsdecode(b'raw-\xff'))
else: p.symlink_to('missing café')
`,
              sourcePath,
              object,
            ],
            sourceBase,
          );
          expect(setup.exitCode).toBe(0);
        } else if (object === "directory") {
          await mkdir(path.join(sourcePath, "nested"), { recursive: true });
          await writeFile(path.join(sourcePath, "nested/bytes"), binary);
          await symlink("missing café", path.join(sourcePath, "broken"));
          await symlink(Buffer.from([114, 97, 119, 45, 255]), path.join(sourcePath, "binary-link"));
        } else await symlink("missing café", sourcePath);
      };
      for (const operation of ["copy", "move"] as const) {
        await seed("directory");
        const sourceIdentity = await lstat(sourcePath);
        // Copy merges; Move replaces the existing tree after both removal policies pass.
        if (targetOwner) {
          const owner = registry.resolve(target);
          if (!owner) throw Error("Missing target owner");
          const setup = await owner.backend.execute(
            "python3",
            [
              "-c",
              "import pathlib,sys;p=pathlib.Path(sys.argv[1]);p.mkdir();(p/'extra').write_text('prior')",
              targetPath,
            ],
            targetBase,
          );
          expect(setup.exitCode).toBe(0);
        } else {
          await mkdir(targetPath);
          await writeFile(path.join(targetPath, "extra"), "prior");
        }
        const result = await operate(
          operation,
          { path: source, target },
          { cwd: local },
          sshTransferPolicy,
        );
        expect(result).toMatchObject({
          ok: true,
          effect: "applied",
          sourceKind: "directory",
          path: source,
          target,
        });
        expect(await readFile(path.join(targetPath, "nested/bytes"))).toEqual(binary);
        expect(await readlink(path.join(targetPath, "broken"))).toBe("missing café");
        expect(
          await readlink(path.join(targetPath, "binary-link"), { encoding: "buffer" }),
        ).toEqual(Buffer.from([114, 97, 119, 45, 255]));
        if (operation === "copy") {
          expect(await readFile(path.join(targetPath, "extra"), "utf8")).toBe("prior");
          expect(await readFile(path.join(sourcePath, "nested/bytes"))).toEqual(binary);
          await rm(sourcePath, { recursive: true });
        } else {
          await expect(lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(lstat(path.join(targetPath, "extra"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          if (route === "same-target")
            expect((await lstat(targetPath)).ino).toBe(sourceIdentity.ino);
        }
        await rm(targetPath, { recursive: true });
        await seed("symlink");
        expect(
          await operate(operation, { path: source, target }, { cwd: local }, sshTransferPolicy),
        ).toMatchObject({ ok: true, sourceKind: "symlink" });
        expect(await readlink(targetPath)).toBe("missing café");
        if (operation === "copy") await rm(sourcePath);
        else await expect(lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
        await rm(targetPath);
      }
    } finally {
      await Promise.all([left.stop(), right.stop()]);
    }
  },
  90_000,
);
