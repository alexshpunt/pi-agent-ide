// @ts-check
// Run only the target's installed Playwright and Chromium; no local browser or shared profile.
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const MAX_HTML_BYTES = 16 * 1024 * 1024;
/** @type {{ browser?: import("playwright-core").Browser }} */
const state = {};
const cancellation = new AbortController();
const stop = () => {
  cancellation.abort();
  if (state.browser) void state.browser.close().catch(() => {});
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGHUP", stop);

class Refused extends Error {}

/** @param {string} candidate */
async function executable(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

async function browserPath() {
  if (process.env.PI_AGENT_IDE_BROWSER_PATH)
    return (
      (await executable(path.resolve(process.env.PI_AGENT_IDE_BROWSER_PATH))) ??
      Promise.reject(new Refused("CAPABILITY_UNAVAILABLE"))
    );
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
      const candidate = await executable(path.join(directory, name));
      if (candidate) return candidate;
    }
  }
  const candidate = await executable("/opt/google/chrome/chrome");
  if (candidate) return candidate;
  throw new Refused("CAPABILITY_UNAVAILABLE");
}

/** @param {URL} url */
function targetProxy(url) {
  /** @type {Record<string, string | undefined>} */
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toLowerCase();
    if (key === normalized || environment[normalized] === undefined)
      environment[normalized] = value;
  }
  const configured = environment[url.protocol === "https:" ? "https_proxy" : "http_proxy"];
  if (!configured) return undefined;
  const proxy = new URL(configured);
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  proxy.username = "";
  proxy.password = "";
  return {
    server: proxy.href,
    bypass: environment.no_proxy ?? "",
    ...(username ? { username, password } : {}),
  };
}

/** @param {{kind: "html" | "image" | "probe", url: string, timeoutMs: number}} request */
async function render(request) {
  const url = new URL(request.url);
  if (
    (request.kind === "probe"
      ? url.href !== "about:blank"
      : !["http:", "https:"].includes(url.protocol)) ||
    url.username ||
    url.password
  )
    throw new Refused("INVALID_SOURCE");
  /** @type {import("playwright-core").BrowserType} */
  let chromium;
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    ({ chromium } = /** @type {typeof import("playwright-core")} */ (
      require(process.env.PI_AGENT_IDE_PLAYWRIGHT_PATH ?? "playwright-core")
    ));
  } catch {
    throw new Refused("CAPABILITY_UNAVAILABLE");
  }
  const executablePath = await browserPath();
  cancellation.signal.throwIfAborted();
  state.browser = await chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox: false,
    timeout: request.timeoutMs,
    proxy: request.kind === "probe" ? undefined : targetProxy(url),
  });
  cancellation.signal.throwIfAborted();
  const page = await state.browser.newPage();
  if (request.kind === "probe") return { ready: true };
  const response = await page.goto(url.href, {
    timeout: request.timeoutMs,
    waitUntil: "domcontentloaded",
  });
  if (response !== null && !response.ok()) throw new Refused("HTTP_FAILED");
  await page
    .waitForLoadState("networkidle", { timeout: Math.min(request.timeoutMs, 1500) })
    .catch(() => {});
  cancellation.signal.throwIfAborted();
  if (request.kind === "image") {
    const dimensions = await page.evaluate(() => ({
      width: Math.max(innerWidth, document.documentElement.scrollWidth, document.body.scrollWidth),
      height: Math.max(
        innerHeight,
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
      ),
    }));
    if (dimensions.width * dimensions.height > 16_000_000) throw new Refused("BYTE_LIMIT");
    const png = await page.screenshot({ type: "png", fullPage: true, timeout: request.timeoutMs });
    if (png.length > 20 * 1024 * 1024) throw new Refused("BYTE_LIMIT");
    cancellation.signal.throwIfAborted();
    return { png: png.toString("base64") };
  }
  await page.locator("body *").evaluateAll((elements) => {
    for (const element of elements.toReversed()) {
      const style = globalThis.getComputedStyle(element);
      if (
        element.hasAttribute("hidden") ||
        element.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      )
        element.remove();
    }
  });
  const html = await page.content();
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) throw new Refused("BYTE_LIMIT");
  cancellation.signal.throwIfAborted();
  return { html, source: page.url() };
}

let reply;
try {
  /** @type {unknown} */
  const request = JSON.parse(process.argv[1] ?? "null");
  if (
    typeof request !== "object" ||
    request === null ||
    !("kind" in request) ||
    (request.kind !== "html" && request.kind !== "image" && request.kind !== "probe") ||
    !("url" in request) ||
    typeof request.url !== "string" ||
    !("timeoutMs" in request) ||
    typeof request.timeoutMs !== "number" ||
    !Number.isFinite(request.timeoutMs) ||
    request.timeoutMs <= 0
  )
    throw new Refused("INVALID_SOURCE");
  reply = await render({ kind: request.kind, url: request.url, timeoutMs: request.timeoutMs });
} catch (error) {
  // Do not expose native browser diagnostics, proxy credentials or environment values.
  reply = {
    error:
      error instanceof Refused
        ? error.message
        : error instanceof Error && error.name === "TimeoutError"
          ? "TIMEOUT"
          : "BROWSER_FAILED",
  };
} finally {
  if (state.browser) await state.browser.close();
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  process.off("SIGHUP", stop);
}
console.log(JSON.stringify(reply));
