// @ts-check
// Run only the target's installed Playwright and Chromium; no local browser or shared profile.
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
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
// Stop closes stdin on Windows; the Job Object is the fallback if Playwright cannot exit.
if (process.platform === "win32") {
  process.stdin.once("end", stop);
  process.stdin.resume();
}

class Refused extends Error {}

/** @param {string} candidate */
async function executable(candidate) {
  try {
    if (!(await stat(candidate)).isFile()) return undefined;
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

/** @param {import("playwright-core").BrowserType} chromium */
async function browserPath(chromium) {
  const override = process.env.PI_AGENT_IDE_BROWSER_PATH;
  if (override) {
    const candidate = await executable(path.resolve(override));
    if (candidate) return candidate;
    throw new Refused("CHROMIUM_UNAVAILABLE");
  }

  const managed = await executable(chromium.executablePath());
  if (managed) return managed;
  const windows = process.platform === "win32";
  const names = windows
    ? ["chrome.exe", "chromium.exe"]
    : ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = await executable(path.join(directory.replace(/^"|"$/gu, ""), name));
      if (candidate) return candidate;
    }
  }
  const standard = windows
    ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
        .filter((directory) => directory !== undefined)
        .map((directory) => path.join(directory, "Google", "Chrome", "Application", "chrome.exe"))
    : ["/opt/google/chrome/chrome"];
  for (const location of standard) {
    const candidate = await executable(location);
    if (candidate) return candidate;
  }
  throw new Refused("CHROMIUM_UNAVAILABLE");
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

/** @param {{kind: "html" | "probe", url: string, timeoutMs: number}} request */
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
    const moduleName = process.env.PI_AGENT_IDE_PLAYWRIGHT_PATH || "playwright-core";
    const entry = require.resolve(moduleName);
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
      // Let the owning package use a hermetic Playwright install without global SSH setup.
      const hermetic = path.join(path.dirname(entry), ".local-browsers");
      if ((await stat(hermetic).catch(() => undefined))?.isDirectory())
        process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
    }
    const installed = /** @type {Partial<typeof import("playwright-core")>} */ (require(entry));
    if (!installed.chromium) throw new Refused("PLAYWRIGHT_UNAVAILABLE");
    chromium = installed.chromium;
  } catch {
    throw new Refused("PLAYWRIGHT_UNAVAILABLE");
  }
  const executablePath = await browserPath(chromium);
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
    (request.kind !== "html" && request.kind !== "probe") ||
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
    error: cancellation.signal.aborted
      ? "CANCELLED"
      : error instanceof Refused
        ? error.message
        : error instanceof Error && error.name === "TimeoutError"
          ? "TIMEOUT"
          : "BROWSER_FAILED",
  };
} finally {
  if (state.browser) await state.browser.close();
  if (process.platform === "win32") process.stdin.destroy();
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  process.off("SIGHUP", stop);
}
console.log(JSON.stringify(reply));
