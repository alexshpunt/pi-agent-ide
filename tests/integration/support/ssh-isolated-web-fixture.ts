import { readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { startSshWebFixture } from "./ssh-web-fixture.js";

/** Start HTTP and SSH in a private network namespace, reachable only through the owned Unix socket. */
export async function startIsolatedSshWebFixture() {
  const controllerNamespace = await readlink("/proc/self/ns/net");
  // Chrome's crash database and XDG files must stay writable by the synthetic SSH account.
  const fixture = await startSshWebFixture(
    "",
    {
      no_proxy: "*",
      XDG_CONFIG_HOME: "{workspace}/.config",
      XDG_CACHE_HOME: "{workspace}/.cache",
      XDG_DATA_HOME: "{workspace}/.local/share",
    },
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
    const probe = await owner.backend.execute(
      "node",
      [
        "-e",
        `
        (async () => {
          const fs = require("node:fs/promises");
          const path = require("node:path");
          const {W_OK} = require("node:fs").constants;
          for (const [key, relative] of [["XDG_CONFIG_HOME",".config"],["XDG_CACHE_HOME",".cache"],["XDG_DATA_HOME",".local/share"]]) {
            const owned = path.join(process.argv[2],relative);
            if (process.env[key] !== owned) throw Error("Synthetic browser directory is not target-owned: "+key);
            await fs.mkdir(owned,{recursive:true});
            await fs.access(owned,W_OK);
          }
          const {chromium} = require(process.env.PI_AGENT_IDE_PLAYWRIGHT_PATH);
          let browser;
          try {
            browser = await chromium.launch({executablePath:process.env.PI_AGENT_IDE_BROWSER_PATH,headless:true,chromiumSandbox:false,timeout:30000});
            const page = await browser.newPage();
            await page.goto(process.argv[1]+"/browser",{waitUntil:"domcontentloaded",timeout:30000});
          } finally { if (browser) await browser.close(); }
        })().catch(error => { console.error(String(error)); process.exitCode=1; });
      `,
        proof.url,
        fixture.workspace,
      ],
      fixture.workspace,
      { signal: AbortSignal.timeout(35_000), timeoutMs: 35_000 },
    );
    if (probe.exitCode !== 0)
      throw Error("Isolated synthetic browser startup failed: " + probe.stderr.toString("utf8"));
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
