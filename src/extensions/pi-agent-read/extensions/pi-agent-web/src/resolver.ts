import type {
  AgentContent,
  ContentHost,
  ResourceResolutionAttempt,
  ResourceResolver,
} from "pi-agent-resource";

import { type BrowserHtmlLoader, createSystemBrowserHtmlLoader } from "./browser-loader.js";

type WebContentHost = Pick<ContentHost, "convert">;

/** HTTP timeout, transport, and internal browser fallback settings. */
export interface WebResolverOptions {
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly browser?: BrowserHtmlLoader;
  readonly autoBrowserFallback?: boolean;
}

/** Creates an HTTP(S) resolver that retries failed reads and empty HTML in a local browser. */
export function createWebResolver(
  contentHost: WebContentHost,
  options: WebResolverOptions = {},
): ResourceResolver {
  const settings = resolverSettings(options);

  return {
    id: "web",
    tryResolve(source) {
      return Promise.resolve(resolveHttpSource(source, contentHost, settings));
    },
  };
}

interface ResolverSettings {
  readonly timeoutMs: number;
  readonly fetchResource: typeof globalThis.fetch;
  readonly browser: BrowserHtmlLoader;
  readonly autoBrowserFallback: boolean;
}

function resolverSettings(options: WebResolverOptions): ResolverSettings {
  const timeoutMs = options.timeoutMs ?? 30_000;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Web timeout must be a positive finite number");
  }

  return {
    timeoutMs,
    fetchResource: options.fetch ?? globalThis.fetch,
    browser: options.browser ?? createSystemBrowserHtmlLoader(),
    autoBrowserFallback: options.autoBrowserFallback ?? true,
  };
}

function resolveHttpSource(
  source: string,
  contentHost: WebContentHost,
  settings: ResolverSettings,
): ResourceResolutionAttempt {
  let url: URL;

  try {
    url = new URL(source);
  } catch (error) {
    return claimsHttpScheme(source)
      ? {
          kind: "failed",
          error: new TypeError(`Invalid HTTP source ${source}`, { cause: error }),
        }
      : { kind: "not-handled" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "not-handled" };
  }

  return {
    kind: "resolved",
    resource: {
      source: url.href,
      read({ signal }) {
        return readWebContent(url, contentHost, settings, signal);
      },
    },
  };
}

async function readWebContent(
  url: URL,
  contentHost: WebContentHost,
  settings: ResolverSettings,
  parentSignal: AbortSignal | undefined,
): Promise<AgentContent> {
  const operation = createOperationSignal(parentSignal, settings.timeoutMs);
  let browserEligible = true;

  try {
    operation.signal.throwIfAborted();
    const response = await settings.fetchResource(url, {
      method: "GET",
      redirect: "follow",
      signal: operation.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Pi-LPT/1.0; +https://github.com/alexshpunt/sasha-pi)",
        Accept:
          "text/html,application/xhtml+xml,application/pdf,application/json,text/plain,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    operation.signal.throwIfAborted();
    const source = response.url.length === 0 ? url.href : response.url;
    const mediaType = response.headers.get("content-type") ?? undefined;
    const input = {
      source,
      bytes,
      ...(mediaType !== undefined && { mediaType }),
    };

    browserEligible = isHtml(bytes, mediaType);
    const content = await contentHost.convert(input, { signal: operation.signal });
    operation.signal.throwIfAborted();
    if (settings.autoBrowserFallback && browserEligible && isEmptyTextContent(content)) {
      throw new Error("HTTP read returned empty HTML content");
    }
    return content;
  } catch (staticError) {
    parentSignal?.throwIfAborted();
    if (!settings.autoBrowserFallback || !browserEligible) {
      throw staticError;
    }
    operation.dispose();
    try {
      return await readBrowserContent(url, contentHost, settings, parentSignal);
    } catch (browserError) {
      parentSignal?.throwIfAborted();
      throw new Error(
        `HTTP read failed (${errorMessage(staticError)}) and browser fallback failed: ${errorMessage(browserError)}`,
        { cause: browserError },
      );
    }
  } finally {
    operation.dispose();
  }
}

async function readBrowserContent(
  url: URL,
  contentHost: WebContentHost,
  settings: ResolverSettings,
  parentSignal: AbortSignal | undefined,
): Promise<AgentContent> {
  const operation = createOperationSignal(parentSignal, settings.timeoutMs);

  try {
    operation.signal.throwIfAborted();
    const content = await loadAndConvertBrowser(url, contentHost, settings, operation.signal);
    operation.signal.throwIfAborted();
    if (isEmptyTextContent(content)) {
      throw new Error("Browser read returned empty content");
    }
    return content;
  } finally {
    operation.dispose();
  }
}

async function loadAndConvertBrowser(
  url: URL,
  contentHost: WebContentHost,
  settings: ResolverSettings,
  signal: AbortSignal,
): Promise<AgentContent> {
  const page = await settings.browser.load(url, { signal, timeoutMs: settings.timeoutMs });
  signal.throwIfAborted();
  return contentHost.convert(
    {
      source: page.source,
      bytes: new TextEncoder().encode(page.html),
      mediaType: "text/html; charset=utf-8",
    },
    { signal },
  );
}

function isHtml(bytes: Uint8Array, mediaType: string | undefined): boolean {
  const normalizedMediaType = mediaType?.split(";", 1)[0]?.trim().toLowerCase();

  if (normalizedMediaType === "text/html" || normalizedMediaType === "application/xhtml+xml") {
    return true;
  }

  const prefix = new TextDecoder("utf8").decode(bytes.subarray(0, 1024));
  return /^\u{FEFF}?\s*(?:<!doctype\s+html\b|<(?:article|body|head|html)\b)/iu.test(prefix);
}

function isEmptyTextContent(content: AgentContent): boolean {
  return content.every((block) => block.type === "text" && block.text.trim().length === 0);
}

interface OperationSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

function createOperationSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): OperationSignal {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort(abortReason(parent));
  };
  const timeout = setTimeout(() => {
    controller.abort(timeoutError(timeoutMs));
  }, timeoutMs);
  timeout.unref();

  if (parent?.aborted === true) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    dispose(): void {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function claimsHttpScheme(source: string): boolean {
  return /^https?:/iu.test(source);
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : abortError();
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`Web read timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
