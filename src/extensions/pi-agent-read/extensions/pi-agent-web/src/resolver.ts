import type { ContentHost, ResourceResolutionAttempt, ResourceResolver } from "pi-agent-resource";

type WebContentHost = Pick<ContentHost, "convert">;

export interface WebResolverOptions {
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export function createWebResolver(
  contentHost: WebContentHost,
  options: WebResolverOptions = {},
): ResourceResolver {
  const timeoutMs = options.timeoutMs ?? 30_000;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Web timeout must be a positive finite number");
  }

  const fetchResource = options.fetch ?? globalThis.fetch;

  return {
    id: "web",
    tryResolve(source) {
      return Promise.resolve(resolveWebSource(source, contentHost, fetchResource, timeoutMs));
    },
  };
}

function resolveWebSource(
  source: string,
  contentHost: WebContentHost,
  fetchResource: typeof globalThis.fetch,
  timeoutMs: number,
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
        return readWebContent(url, contentHost, fetchResource, timeoutMs, signal);
      },
    },
  };
}

async function readWebContent(
  url: URL,
  contentHost: WebContentHost,
  fetchResource: typeof globalThis.fetch,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
) {
  const operation = createOperationSignal(parentSignal, timeoutMs);

  try {
    operation.signal.throwIfAborted();
    const response = await fetchResource(url, {
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
    return await contentHost.convert(
      {
        source,
        bytes,
        ...(mediaType !== undefined && { mediaType }),
      },
      { signal: operation.signal },
    );
  } finally {
    operation.dispose();
  }
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
