import { cp, realpath } from "node:fs/promises";
import path from "node:path";
import { startSshFixture } from "./ssh-fixture.js";

/** Copy only the installed public Playwright runtime into an owned unprivileged SSH fixture. */
export async function startSshWebFixture(
  proxy: string,
  environment: Record<string, string> = {},
  network?: { readonly server: string; readonly proxy: string },
) {
  const fixture = await startSshFixture(
    {},
    {
      http_proxy: proxy,
      no_proxy: "",
      HOME: "{workspace}",
      PI_AGENT_IDE_PLAYWRIGHT_PATH: "{workspace}/playwright-core",
      PI_AGENT_IDE_BROWSER_PATH: "/usr/bin/google-chrome",
      ...environment,
    },
    network,
  );
  try {
    const runtime = await realpath(path.resolve("node_modules/playwright-core"));
    for (const entry of ["lib", "index.js", "browsers.json", "package.json", "LICENSE", "NOTICE"])
      await cp(path.join(runtime, entry), path.join(fixture.workspace, "playwright-core", entry), {
        recursive: true,
        filter: (file) => !/^(?:\.env(?:\..*)?|.*\.(?:pem|key))$/u.test(path.basename(file)),
      });
    return fixture;
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}
