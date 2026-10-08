import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startSshFixture } from "./ssh-fixture.js";

/** Seed only a private OpenSSH proxy diagnostic; never use a real secret or user SSH configuration. */
export async function startSshPrivateDiagnosticFixture() {
  const fixture = await startSshFixture({
    "private-diagnostic": path.resolve("tests/integration/fixtures/ssh-private-diagnostic.py"),
  });
  try {
    const canary = "LPT149_TRANSPORT_DIAGNOSTIC_CANARY";
    const config = path.join(fixture.root, "proxy_config");
    await writeFile(
      config,
      (await readFile(fixture.config, "utf8")) +
        `  ProxyCommand /usr/bin/python3 ${fixture.root}/bin/private-diagnostic ${canary}\n`,
    );
    return {
      ...fixture,
      canary,
      target: {
        id: "private-diagnostic",
        host: "fixture",
        workspace: fixture.workspace,
        configFile: config,
      },
    };
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}
