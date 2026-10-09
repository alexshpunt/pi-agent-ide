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
    const proof: unknown = JSON.parse(
      await readFile(path.join(fixture.workspace, "network-proof.json"), "utf8"),
    );
    if (
      typeof proof !== "object" ||
      proof === null ||
      !("sshdPid" in proof) ||
      typeof proof.sshdPid !== "number" ||
      !Number.isSafeInteger(proof.sshdPid) ||
      proof.sshdPid < 1
    )
      throw Error("Invalid owned SSH server proof");
    // PID 1 can also adopt a closing SSH probe. Select the server's recorded native PID.
    const servers = await Promise.all(
      nativeChildren.map(async (pid) => {
        try {
          const childStatus = await readFile(`/proc/${pid}/status`, "utf8");
          const nativePid = /^NSpid:\s+([\d \t]+)$/mu
            .exec(childStatus)?.[1]
            ?.trim()
            .split(/\s+/u)
            .at(-1);
          return nativePid === String(proof.sshdPid) ? pid : undefined;
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return undefined;
          throw error;
        }
      }),
    );
    const ownedServers = servers.filter((pid) => pid !== undefined);
    const [controllerSshdPid] = ownedServers;
    if (ownedServers.length !== 1 || controllerSshdPid === undefined)
      throw Error("Owned init has no unique recorded SSH server child");
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
