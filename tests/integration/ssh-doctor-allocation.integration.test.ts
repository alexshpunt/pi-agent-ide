import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createSshDoctorWorkspace } from "#src/backend/doctor-workspace.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import * as channels from "#src/backend/ssh-channel.js";
import { startSshFixture } from "./support/ssh-fixture.js";
import { probeOwnedDoctorAllocation } from "./support/ssh-doctor-allocation-probe.js";

// Lose only the owned allocation reply after its real filesystem effects. Keep a private receipt for RED cleanup.
test("Doctor cleans its native allocation when its creation receipt is lost", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const source = `ssh://fixture${fixture.workspace}`;
  const owner = registry.resolve(source);
  if (!owner) throw new Error("Missing fixture owner");
  const receipt = `${fixture.workspace}/owned-allocation-receipt.json`;
  const start = channels.startSshProcess;
  const intercepted = vi.spyOn(channels, "startSshProcess");
  try {
    await owner.backend.write(
      `${fixture.workspace}/note.ts`,
      Buffer.from('const label = "café";\n'),
      null,
    );
    const workspace = await createSshDoctorWorkspace(registry, source);
    const use = vi.fn(async () => "must not run without a receipt");
    intercepted.mockImplementationOnce((target, command, args, cwd, context) =>
      start(
        target,
        command,
        [
          "-c",
          `import builtins, pathlib\ndef lose_owned_reply(value, *args, **kwargs):\n    pathlib.Path(${JSON.stringify(receipt)}).write_text(value, encoding="utf8")\nbuiltins.print = lose_owned_reply\n${args[1]}`,
          ...args.slice(2),
        ],
        cwd,
        context,
      ),
    );
    await expect(workspace.withProbeCopy(`${source}/note.ts`, use)).rejects.toBeInstanceOf(Error);
    expect(use).not.toHaveBeenCalled();
    await expect(owner.backend.stat(`${fixture.workspace}/.tmp`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await owner.backend.read(`${fixture.workspace}/note.ts`)).bytes.toString("utf8")).toBe(
      'const label = "café";\n',
    );
  } finally {
    intercepted.mockRestore();
    try {
      // This exact receipt came from our own native allocation, never a scan or a guessed PID.
      let data: unknown;
      try {
        data = JSON.parse(await readFile(receipt, "utf8"));
      } catch {
        data = undefined;
      }
      if (
        typeof data === "object" &&
        data !== null &&
        "directory" in data &&
        typeof data.directory === "string"
      ) {
        const script = await readFile(path.resolve("src/backend/doctor-probe-worker.py"), "utf8");
        await owner.backend.execute(
          "python3",
          ["-c", script, JSON.stringify({ ...data, operation: "remove", name: "note.ts" })],
          fixture.workspace,
        );
        if (
          "containerCreated" in data &&
          data.containerCreated === true &&
          "containerDevice" in data &&
          "containerInode" in data
        ) {
          await owner.backend.execute(
            "python3",
            [
              "-c",
              script,
              JSON.stringify({
                operation: "remove-container",
                container: `${fixture.workspace}/.tmp`,
                device: data.containerDevice,
                inode: data.containerInode,
              }),
            ],
            fixture.workspace,
          );
        }
      }
    } finally {
      await fixture.stop();
    }
  }
}, 20_000);

test("failed native entry creation releases only its newly created container", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const project = `ssh://fixture${fixture.workspace}`;
  const owner = registry.resolve(project);
  if (!owner) throw new Error("Missing fixture owner");
  const start = channels.startSshProcess;
  const intercepted = vi.spyOn(channels, "startSshProcess");
  try {
    await owner.backend.write(
      `${fixture.workspace}/note.ts`,
      Buffer.from('const label = "café";\n'),
      null,
    );
    const workspace = await createSshDoctorWorkspace(registry, project);
    intercepted.mockImplementationOnce((target, command, args, cwd, context) =>
      start(
        target,
        command,
        [
          "-c",
          `import tempfile\ndef refuse_owned_entry(*args, **kwargs):\n    raise OSError("Owned entry allocation refused")\ntempfile.mkdtemp = refuse_owned_entry\n${args[1]}`,
          ...args.slice(2),
        ],
        cwd,
        context,
      ),
    );
    const use = vi.fn(async () => "must not run");
    await expect(workspace.withProbeCopy(`${project}/note.ts`, use)).rejects.toMatchObject({
      code: "PROBE_FAILED",
    });
    expect(use).not.toHaveBeenCalled();
    await expect(owner.backend.stat(`${fixture.workspace}/.tmp`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await owner.backend.read(`${fixture.workspace}/note.ts`)).bytes.toString("utf8")).toBe(
      'const label = "café";\n',
    );
  } finally {
    intercepted.mockRestore();
    await fixture.stop();
  }
}, 20_000);
test("native rollback preserves a foreign probe entry and reports its cleanup refusal", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const project = `ssh://fixture${fixture.workspace}`;
  const owner = registry.resolve(project);
  if (!owner) throw new Error("Missing fixture owner");
  const receipt = `${fixture.workspace}/owned-allocation-receipt.json`;
  const start = channels.startSshProcess;
  const intercepted = vi.spyOn(channels, "startSshProcess");
  try {
    await owner.backend.write(
      `${fixture.workspace}/note.ts`,
      Buffer.from('const label = "café";\n'),
      null,
    );
    const workspace = await createSshDoctorWorkspace(registry, project);
    intercepted.mockImplementationOnce((target, command, args, cwd, context) =>
      start(
        target,
        command,
        [
          "-c",
          `import builtins, json, pathlib
def lose_owned_reply(value, *args, **kwargs):
    data = json.loads(value)
    if isinstance(data, dict) and 'directory' in data:
        pathlib.Path(${JSON.stringify(receipt)}).write_text(value, encoding="utf8")
        pathlib.Path(data['directory'], 'external.txt').write_text("external café", encoding="utf8")
builtins.print = lose_owned_reply
${args[1]}`,
          ...args.slice(2),
        ],
        cwd,
        context,
      ),
    );
    const use = vi.fn(async () => "must not run");
    const failure: unknown = await workspace
      .withProbeCopy(`${project}/note.ts`, use)
      .catch((error: unknown) => error);
    expect(use).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Missing cleanup refusal");
    expect(failure.errors).toContainEqual(
      expect.objectContaining({ code: "PROBE_CLEANUP_FAILED", effect: "unknown" }),
    );
    const data: unknown = JSON.parse(await readFile(receipt, "utf8"));
    if (
      typeof data !== "object" ||
      data === null ||
      !("directory" in data) ||
      typeof data.directory !== "string"
    )
      throw new Error("Missing exact foreign-entry receipt");
    expect(
      (await owner.backend.read(`${data.directory}/external.txt`)).bytes.toString("utf8"),
    ).toBe("external café");
    expect((await owner.backend.read(`${fixture.workspace}/note.ts`)).bytes.toString("utf8")).toBe(
      'const label = "café";\n',
    );
  } finally {
    intercepted.mockRestore();
    await fixture.stop();
  }
}, 20_000);

test.each([
  { mode: "lost", existing: false },
  { mode: "cancel", existing: false },
  { mode: "lost", existing: true },
] as const)(
  "native allocation $mode retains a sibling and respects an existing container ($existing)",
  async ({ mode, existing }) => {
    const result = await probeOwnedDoctorAllocation(mode, existing);
    expect(result).toMatchObject({
      nativeGoneBeforeTeardown: true,
      allocationGoneBeforeTeardown: true,
      siblingRetained: true,
      sourcePreserved: true,
      cancellationRetained: mode === "cancel" ? true : null,
      existingContainerPreserved: existing ? true : null,
    });
  },
  25_000,
);
