import type {
  AgentContent,
  ContentHost,
  ResourceResolutionAttempt,
  ResourceResolver,
} from "pi-agent-resource";

import { type BrowserHtmlLoader, createSystemBrowserHtmlLoader } from "./browser-loader.js";

type WebContentHost = Pick<ContentHost, "convert">;

const BINARY_PREVIEW_BYTES = 4096;

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

    const mediaType = response.headers.get("content-type") ?? undefined;
    if (isUnsupportedBinaryMediaType(mediaType) && !hasSupportedDocumentExtension(url)) {
      const preview = await readBoundedBody(response, BINARY_PREVIEW_BYTES, operation.signal);
      return [
        {
          type: "text",
          text: formatUnsupportedBinaryResponse(url, response, mediaType, preview),
        },
      ];
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    operation.signal.throwIfAborted();
    const source = response.url.length === 0 ? url.href : response.url;
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

function isUnsupportedBinaryMediaType(mediaType: string | undefined): boolean {
  if (mediaType === undefined) return false;
  const type = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return !(
    type.startsWith("text/") ||
    type.startsWith("image/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/xml" ||
    type.endsWith("+xml") ||
    type === "application/xhtml+xml" ||
    type === "application/pdf"
  );
}

function hasSupportedDocumentExtension(url: URL): boolean {
  return /\.(?:avif|bmp|gif|jpe?g|pdf|png|webp)$/iu.test(url.pathname);
}

async function readBoundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      const remaining = limit - length;
      const chunk = part.value.subarray(0, remaining);
      chunks.push(chunk);
      length += chunk.length;
      if (part.value.length > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const preview = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    preview.set(chunk, offset);
    offset += chunk.length;
  }
  return preview;
}

function formatUnsupportedBinaryResponse(
  requestedUrl: URL,
  response: Response,
  mediaType: string | undefined,
  preview: Uint8Array,
): string {
  const lines = [
    "Binary response",
    `URL: ${requestedUrl.href}`,
    `HTTP: ${response.status} ${response.statusText}`.trimEnd(),
    `Content-Type: ${mediaType ?? "unknown"}`,
  ];
  const disposition = response.headers.get("content-disposition");
  const filename = disposition === null ? undefined : attachmentFilename(disposition);
  if (filename !== undefined) lines.push(`Filename: ${filename}`);
  const length = response.headers.get("content-length");
  if (length !== null) lines.push(`Content-Length: ${length}`);
  lines.push("", "Headers:");
  for (const [name, value] of [...response.headers].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (isSensitiveRedirectHeader(name)) continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push(
    "",
    `Preview: first ${preview.length} bytes (hex); the remaining body was not downloaded`,
    formatHexPreview(preview),
  );
  return lines.join("\n");
}

function attachmentFilename(disposition: string): string | undefined {
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded).replaceAll(/[\r\n]/gu, "");
    } catch {
      return encoded.replaceAll(/[\r\n]/gu, "");
    }
  }
  return /filename=(?:"([^"]+)"|([^;]+))/iu.exec(disposition)?.slice(1).find(Boolean)?.trim();
}

function isSensitiveRedirectHeader(name: string): boolean {
  return ["content-location", "link", "location", "refresh", "set-cookie"].includes(
    name.toLowerCase(),
  );
}

function formatHexPreview(bytes: Uint8Array): string {
  if (bytes.length === 0) return "(empty body)";
  const rows: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.subarray(offset, offset + 16);
    const hex = [...chunk].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const text = [...chunk]
      .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCodePoint(byte) : "."))
      .join("");
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  |${text}|`);
  }
  return rows.join("\n");
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
