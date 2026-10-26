import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { readSshProcessMetadata } from "#integration/support/ssh-process-metadata.js";

test("remote process metadata retains its target, executable and kernel start identity", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const owner = registry.resolve(scope);
  if (!owner) throw new Error("Missing fixture owner");
  const child = await owner.backend.startProcess(
    "python3",
    ["-c", "import time; time.sleep(60)"],
    fixture.workspace,
  );
  try {
    const [metadata] = await readSshProcessMetadata(registry, scope, child.pid);
    expect(metadata).toMatchObject({
      pid: child.pid,
    });
    expect(metadata?.identity).toMatch(/^[a-f0-9-]+:\d+$/u);
    expect(child.identity).toBe(metadata?.identity);
    expect(metadata?.executable).toContain("python3");
    expect(metadata?.command).toContain("time.sleep(60)");
    await expect(
      readSshProcessMetadata(registry, "ssh://unknown/tmp", child.pid),
    ).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
    await expect(readSshProcessMetadata(registry, scope, -1)).rejects.toThrow(
      "Invalid process PID",
    );
  } finally {
    await child.stop();
    await fixture.stop();
  }
}, 15000);

test("remote metadata redacts adapter authentication arguments before returning command text", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const owner = registry.resolve(scope);
  if (!owner) throw new Error("Missing fixture owner");
  const child = await owner.backend.startProcess(
    "python3",
    [
      "-c",
      "import time; time.sleep(60)",
      "owned-marker",
      "--adapter-access-token",
      "test-only-adapter-value",
      "--client-access-token=test-only-client-value",
      "--server-access-token",
      "test-only-server-value",
    ],
    fixture.workspace,
  );
  try {
    const [metadata] = await readSshProcessMetadata(registry, scope, child.pid);
    expect(metadata?.command).toContain("owned-marker");
    expect(metadata?.command).toContain("--adapter-access-token [redacted]");
    expect(metadata?.command).toContain("--client-access-token=[redacted]");
    expect(metadata?.command).toContain("--server-access-token [redacted]");
    expect(metadata?.command).not.toContain("test-only-adapter-value");
    expect(metadata?.command).not.toContain("test-only-client-value");
    expect(metadata?.command).not.toContain("test-only-server-value");
  } finally {
    await child.stop();
    await fixture.stop();
  }
}, 15000);
