import { readlink, stat } from "node:fs/promises";
import { expect, test } from "vitest";
import { fetchSshWebResponse } from "#src/backend/web-http.js";
import { readSshBrowserPage } from "#src/backend/web-browser.js";
import { startIsolatedSshWebFixture } from "./support/ssh-isolated-web-fixture.js";

test("native HTTP and Playwright reach an endpoint unavailable in the controller network", async () => {
  const fixture = await startIsolatedSshWebFixture();
  const { target, controllerNamespace } = fixture;
  try {
    await expect(
      fetch(fixture.url + "/static", { signal: AbortSignal.timeout(2000) }),
    ).rejects.toBeInstanceOf(Error);
    const url = new URL(fixture.url + "/static?value=42#section");
    const response = await fetchSshWebResponse(target, url, `web:ssh://fixture/${url.href}`);
    expect(await response.text()).toContain("Isolated café HTTP");
    const browser = new URL(fixture.url + "/browser");
    const rendered = await readSshBrowserPage(
      target,
      browser,
      `web:ssh://fixture/${browser.href}`,
      { timeoutMs: 5000 },
    );
    expect(rendered.html).toContain("Isolated café browser");
    expect(rendered.html).toContain("Native value 43");
    expect(await readlink("/proc/self/ns/net")).toBe(controllerNamespace);
    await expect(
      fetch(fixture.url + "/red", { signal: AbortSignal.timeout(2000) }),
    ).rejects.toBeInstanceOf(Error);
  } finally {
    await fixture.stop();
    for (const file of [fixture.root, `/proc/${fixture.supervisorPid}`, `/proc/${fixture.sshdPid}`])
      await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 30_000);
