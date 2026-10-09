import path from "node:path";
import { requiredValue } from "pi-agent-invariant";
import { createSshDoctorWorkspace } from "#src/backend/doctor-workspace.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { SshBackendError } from "#src/backend/ssh.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { startSshFixture } from "./ssh-fixture.js";

async function absent(use: () => Promise<unknown>): Promise<void> {
  try {
    await use();
  } catch (error) {
    if (error instanceof SshBackendError && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Owned native allocation remained before fixture teardown");
}

/** Exercise actual receipt loss or cancellation, then a sibling handoff on the same native owner. */
export async function probeOwnedDoctorAllocation(
  mode: "lost" | "cancel",
  existingContainer = false,
) {
  const fixture = await startSshFixture(
    { python3: path.resolve("tests/integration/fixtures/doctor-allocation-python.py") },
    { PI_IDE_OWNED_ALLOCATION_WORKSPACE: "{workspace}" },
  );
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const project = `ssh://fixture${fixture.workspace}`;
  const owner = requiredValue(registry.resolve(project));
  const controller = new AbortController();
  const reason = new Error("Cancel owned allocation before receipt");
  const callbacks: { release?: () => void; ready?: () => void } = {};
  const release = new Promise<void>((resolve) => {
    callbacks.release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    callbacks.ready = resolve;
  });
  const pending: Promise<unknown>[] = [];
  const callbackState = { invoked: false };
  try {
    const content = 'const label = "café";\n';
    const file = `${fixture.workspace}/note.ts`;
    await owner.backend.write(file, Buffer.from(content), null);
    const external = `${fixture.workspace}/.tmp/external.txt`;
    if (existingContainer) await owner.backend.write(external, Buffer.from("external café"), null);
    const workspace = await createSshDoctorWorkspace(registry, project);
    const first = workspace
      .withProbeCopy(
        `${project}/note.ts`,
        async () => {
          callbackState.invoked = true;
        },
        controller.signal,
      )
      .then(
        () => {
          throw new Error("Allocation without a receipt was accepted");
        },
        (error: unknown) => error,
      );
    pending.push(first);
    let receipt: unknown;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try {
        receipt = JSON.parse(
          (
            await owner.backend.read(`${fixture.workspace}/owned-allocation-receipt.json`)
          ).bytes.toString("utf8"),
        );
        break;
      } catch (error) {
        if (!(error instanceof SshBackendError) || error.code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      !("pid" in receipt) ||
      typeof receipt.pid !== "number" ||
      !("directory" in receipt) ||
      typeof receipt.directory !== "string"
    )
      throw new Error("No exact native allocation receipt");
    const pid = receipt.pid;
    const directory = receipt.directory;
    // Queue the next startup while the first native allocator still owns rollback.
    await owner.backend.write(`${fixture.workspace}/allow-allocation`, Buffer.alloc(0), null);
    const sibling = workspace.withProbeCopy(`${project}/note.ts`, async (probe) => {
      if ((await workspace.readText(probe)) !== content)
        throw new Error("Sibling probe changed the source");
      requiredValue(callbacks.ready)();
      await release;
      return "sibling";
    });
    pending.push(sibling);
    void sibling.catch(() => {});
    if (mode === "cancel") controller.abort(reason);
    const failure = await first;
    if (
      callbackState.invoked ||
      !(failure instanceof Error) ||
      (mode === "cancel" && failure !== reason)
    )
      throw new Error("Allocation refusal did not retain its invocation outcome", {
        cause: failure,
      });
    await absent(() => readSshProcessMetadata(registry, project, pid));
    await absent(() => owner.backend.stat(directory));
    await Promise.race([
      ready,
      sibling.then(() => {
        throw new Error("Sibling finished before observation");
      }),
    ]);
    const sourcePreserved = (await owner.backend.read(file)).bytes.toString("utf8") === content;
    if (!sourcePreserved) throw new Error("Allocation cleanup changed the original source");
    requiredValue(callbacks.release)();
    if ((await sibling) !== "sibling") throw new Error("Sibling probe did not complete");
    if (existingContainer) {
      if ((await owner.backend.read(external)).bytes.toString("utf8") !== "external café")
        throw new Error("Allocation cleanup changed the existing container");
    } else {
      await absent(() => owner.backend.stat(`${fixture.workspace}/.tmp`));
    }
    return {
      root: fixture.root,
      project,
      mode,
      pid,
      nativeGoneBeforeTeardown: true,
      allocationGoneBeforeTeardown: true,
      siblingRetained: true,
      sourcePreserved,
      existingContainerPreserved: existingContainer ? true : null,
      cancellationRetained: mode === "cancel" ? failure === reason : null,
    };
  } finally {
    controller.abort(reason);
    requiredValue(callbacks.release)();
    await Promise.allSettled(pending);
    await fixture.stop();
  }
}
