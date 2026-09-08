import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

const browserNames = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
const browserPaths = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
];

/** Rendered HTML and final URL returned by a browser page load. */
export interface BrowserPageSnapshot {
  readonly html: string;
  readonly source: string;
}

/** Loads one HTTP(S) page in a real browser and returns its rendered DOM. */
export interface BrowserHtmlLoader {
  load(url: URL, options: BrowserLoadOptions): Promise<BrowserPageSnapshot>;
}

/** Cancellation and deadline settings for one browser page load. */
export interface BrowserLoadOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

/** Options for the system Chrome/Chromium loader. */
export interface SystemBrowserHtmlLoaderOptions {
  readonly executablePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Creates a loader backed by an installed Chrome or Chromium executable.
 * `PI_AGENT_IDE_BROWSER_PATH` overrides executable discovery.
 */
export function createSystemBrowserHtmlLoader(
  options: SystemBrowserHtmlLoaderOptions = {},
): BrowserHtmlLoader {
  let executable: Promise<string> | undefined;

  return {
    async load(url, loadOptions) {
      executable ??= resolveSystemBrowserExecutable(
        options.executablePath,
        options.environment ?? process.env,
      );
      const executablePath = await executable;
      loadOptions.signal?.throwIfAborted();
      const { chromium } = await import("playwright-core");
      loadOptions.signal?.throwIfAborted();
      const browser = await chromium.launch({
        executablePath,
        headless: true,
        chromiumSandbox: false,
      });
      const closeOnAbort = (): void => {
        void browser.close();
      };
      loadOptions.signal?.addEventListener("abort", closeOnAbort, { once: true });

      try {
        loadOptions.signal?.throwIfAborted();
        const page = await browser.newPage();
        const response = await page.goto(url.href, {
          timeout: loadOptions.timeoutMs,
          waitUntil: "domcontentloaded",
        });

        if (response !== null && !response.ok()) {
          throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
        }
        await page
          .waitForLoadState("networkidle", { timeout: Math.min(loadOptions.timeoutMs, 1_500) })
          .catch(() => {});
        loadOptions.signal?.throwIfAborted();
        await removeHiddenElements(page);
        const snapshot = { html: await page.content(), source: page.url() };
        loadOptions.signal?.throwIfAborted();
        return snapshot;
      } catch (error) {
        if (loadOptions.signal?.aborted === true) {
          throw abortReason(loadOptions.signal);
        }

        throw new Error(`Browser read failed for ${url.href}: ${errorMessage(error)}`, {
          cause: error,
        });
      } finally {
        loadOptions.signal?.removeEventListener("abort", closeOnAbort);
        await browser.close().catch(() => {});
      }
    },
  };
}

/** Finds the Chrome/Chromium executable used by browser reads. */
export async function resolveSystemBrowserExecutable(
  configuredPath: string | undefined = process.env.PI_AGENT_IDE_BROWSER_PATH,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (configuredPath !== undefined && configuredPath.trim().length > 0) {
    const candidate = path.resolve(configuredPath);

    if (await isExecutable(candidate)) {
      return candidate;
    }

    throw new Error(`PI_AGENT_IDE_BROWSER_PATH is not executable: ${candidate}`);
  }

  for (const directory of (environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of browserNames) {
      const candidate = path.join(directory, name);

      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  for (const candidate of browserPaths) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "No system Chrome or Chromium executable was found. Install Chrome/Chromium or set PI_AGENT_IDE_BROWSER_PATH.",
  );
}

async function removeHiddenElements(page: {
  locator(selector: string): {
    evaluateAll<Result>(callback: (elements: Element[]) => Result): Promise<Result>;
  };
}): Promise<void> {
  await page.locator("body *").evaluateAll((elements) => {
    for (const element of elements.toReversed()) {
      const style = globalThis.getComputedStyle(element);

      if (
        element.hasAttribute("hidden") ||
        element.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      ) {
        element.remove();
      }
    }
  });
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : abortError();
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
