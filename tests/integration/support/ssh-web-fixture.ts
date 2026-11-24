import { constants } from "node:fs";
import { cp, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { integrationChromiumPath } from "./browser-runtime.ts";
import { startSshFixture } from "./ssh-fixture.ts";

/** Expose the checkout's pinned browser runtime inside an owned SSH fixture. */
export async function startSshWebFixture(
  proxy: string,
  environment: Record<string, string> = {},
  network?: { readonly server: string; readonly proxy: string },
) {
  const chromium =
    environment.PI_AGENT_IDE_BROWSER_PATH === undefined ? integrationChromiumPath() : undefined;
  const fixture = await startSshFixture(
    {},
    {
      http_proxy: proxy,
      no_proxy: "",
      HOME: "{workspace}",
      PI_AGENT_IDE_PLAYWRIGHT_PATH: "{workspace}/playwright-core",
      ...(chromium && {
        PI_AGENT_IDE_BROWSER_PATH: `{workspace}/chromium/${path.basename(chromium)}`,
      }),
      ...environment,
    },
    network,
  );
  try {
    if (chromium) {
      const bundle = path.dirname(chromium);
      const target = path.join(fixture.workspace, "chromium");
      // Under sudo the SSH account may not be able to traverse the controller checkout.
      if (process.getuid?.() === 0) {
        await cp(bundle, target, { recursive: true, mode: constants.COPYFILE_FICLONE });
      } else {
        await symlink(bundle, target, "dir");
      }
    }
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
