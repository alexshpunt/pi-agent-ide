import { readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { startSshFixture } from "./ssh-fixture.js";

/** Own one private PID, mount and network namespace with native PID 1 behind a Unix SSH proxy. */
export async function startSshPidNamespaceFixture() {
  const controllerNamespace = await readlink("/proc/self/ns/pid");
  const fixture = await startSshFixture(
    {},
    {},
    {
      server: path.resolve("tests/integration/fixtures/ssh-network-server.py"),
      proxy: path.resolve("tests/integration/fixtures/ssh-network-proxy.py"),
      pidNamespace: true,
    },
  );
  try {
    const children = (
      await readFile(`/proc/${fixture.serverPid}/task/${fixture.serverPid}/children`, "utf8")
    )
      .trim()
      .split(/\s+/u)
      .map(Number);
    const [controllerPid] = children;
    if (
      children.length !== 1 ||
      controllerPid === undefined ||
      !Number.isSafeInteger(controllerPid) ||
      controllerPid < 1
    )
      throw new Error("Namespace wrapper does not own exactly one init child");
    const status = await readFile(`/proc/${controllerPid}/status`, "utf8");
    if (!/^NSpid:\s+\d+\s+1$/mu.test(status))
      throw new Error("Owned supervisor is not native PID 1");
    const namespace = await readlink(`/proc/${controllerPid}/ns/pid`);
    if (namespace === controllerNamespace) throw new Error("PID namespace is not isolated");
    const nativeChildren = (
      await readFile(`/proc/${controllerPid}/task/${controllerPid}/children`, "utf8")
    )
      .trim()
      .split(/\s+/u)
      .map(Number);
    const [controllerSshdPid] = nativeChildren;
    if (
      nativeChildren.length !== 1 ||
      controllerSshdPid === undefined ||
      !Number.isSafeInteger(controllerSshdPid) ||
      controllerSshdPid < 1
    )
      throw new Error("Owned init does not have exactly one SSH server child");
    return {
      ...fixture,
      namespace,
      controllerNamespace,
      controllerPid,
      controllerSshdPid,
    };
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}
