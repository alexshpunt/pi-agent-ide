import { readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { startSshWebFixture } from "./ssh-web-fixture.js";

/** Start HTTP and SSH in a private network namespace, reachable only through the owned Unix socket. */
export async function startIsolatedSshWebFixture() {
  const controllerNamespace = await readlink("/proc/self/ns/net");
  const fixture = await startSshWebFixture(
    "",
    { no_proxy: "*" },
    {
      server: path.resolve("tests/integration/fixtures/ssh-network-server.py"),
      proxy: path.resolve("tests/integration/fixtures/ssh-network-proxy.py"),
    },
  );
  try {
    const proof: unknown = JSON.parse(
      await readFile(path.join(fixture.workspace, "network-proof.json"), "utf8"),
    );
    if (
      typeof proof !== "object" ||
      proof === null ||
      !("url" in proof) ||
      typeof proof.url !== "string" ||
      !("namespace" in proof) ||
      typeof proof.namespace !== "string" ||
      !("supervisorPid" in proof) ||
      typeof proof.supervisorPid !== "number" ||
      !("sshdPid" in proof) ||
      typeof proof.sshdPid !== "number" ||
      !Number.isSafeInteger(proof.supervisorPid) ||
      proof.supervisorPid < 1 ||
      !Number.isSafeInteger(proof.sshdPid) ||
      proof.sshdPid < 1
    )
      throw new Error("Invalid isolated endpoint proof");
    if (proof.namespace === controllerNamespace)
      throw new Error("Endpoint shares the controller network");
    const target = {
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    };
    const owner = new SshBackendRegistry([target]).resolve(`ssh://fixture${fixture.workspace}`);
    if (!owner) throw new Error("No isolated SSH owner");
    const native = await owner.backend.execute(
      "readlink",
      ["/proc/self/ns/net"],
      fixture.workspace,
    );
    if (native.stdout.toString("utf8").trim() !== proof.namespace)
      throw new Error("SSH escaped the private network");
    return {
      ...fixture,
      target,
      url: proof.url,
      namespace: proof.namespace,
      controllerNamespace,
      supervisorPid: proof.supervisorPid,
      sshdPid: proof.sshdPid,
    };
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}
