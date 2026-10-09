import { readlink, stat } from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, test } from "vitest";
import { fetchSshWebResponse } from "#src/backend/web-http.js";
import { captureSshBrowserImage, readSshBrowserPage } from "#src/backend/web-browser.js";
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
    const red = new URL(fixture.url + "/red");
    const image = await loadImage(
      Buffer.from(await captureSshBrowserImage(target, red, `web:ssh://fixture/${red.href}`)),
    );
    const canvas = createCanvas(image.width, image.height);
    const paint = canvas.getContext("2d");
    paint.drawImage(image, 0, 0);
    expect([...paint.getImageData(640, 360, 1, 1).data]).toEqual([255, 0, 0, 255]);
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
