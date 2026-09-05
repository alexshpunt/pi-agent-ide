import { expect, test, vi } from "vitest";
import type { AgentContent, ContentHost } from "pi-agent-resource";
import { createWebResolver } from "#src/resolver.js";

const source = "https://example.test/page";
const rendered: AgentContent = [{ type: "text", text: "Rendered body" }];
const empty: AgentContent = [{ type: "text", text: "" }];

function fixture(
  fetch: typeof globalThis.fetch = vi.fn(async () => new Response("blocked", { status: 403 })),
) {
  const browser = { load: vi.fn(async () => ({ html: "<main>Rendered body</main>", source })) };
  const host = { convert: vi.fn<ContentHost["convert"]>(async () => rendered) };
  return { fetch, browser, host };
}

async function read(f: ReturnType<typeof fixture>, signal?: AbortSignal, timeoutMs = 1000) {
  const resolver = createWebResolver(f.host, { fetch: f.fetch, browser: f.browser, timeoutMs });
  const attempt = await resolver.tryResolve(source, { cwd: "/workspace" });
  if (attempt.kind !== "resolved" || !attempt.resource.read) throw new Error("Not resolved");
  return attempt.resource.read({ signal });
}

test.each([403, 503])("retries HTTP %s in the browser once", async (status) => {
  const f = fixture(vi.fn(async () => new Response("blocked", { status })));
  await expect(read(f)).resolves.toEqual(rendered);
  expect(f.browser.load).toHaveBeenCalledOnce();
  expect(f.host.convert).toHaveBeenCalledWith(
    expect.objectContaining({ source, mediaType: "text/html; charset=utf-8" }),
    expect.anything(),
  );
});

test("retries network failures", async () => {
  const f = fixture(
    vi.fn(async () => {
      throw new Error("fetch failed");
    }),
  );
  await expect(read(f)).resolves.toEqual(rendered);
  expect(f.browser.load).toHaveBeenCalledOnce();
});

test.each(["empty", "failed"])("retries %s HTML extraction", async (mode) => {
  const f = fixture(
    vi.fn(async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })),
  );
  if (mode === "empty") f.host.convert.mockResolvedValueOnce(empty);
  else f.host.convert.mockRejectedValueOnce(new Error("conversion failed"));
  await expect(read(f)).resolves.toEqual(rendered);
  expect(f.browser.load).toHaveBeenCalledOnce();
});

test.each(["text/html", "text/plain", "application/json"])(
  "keeps successful %s reads on HTTP",
  async (mediaType) => {
    const f = fixture(
      vi.fn(async () => new Response("body", { headers: { "content-type": mediaType } })),
    );
    await expect(read(f)).resolves.toEqual(rendered);
    expect(f.browser.load).not.toHaveBeenCalled();
  },
);

test("preserves empty plain text and non-HTML conversion errors", async () => {
  const f = fixture(
    vi.fn(async () => new Response("", { headers: { "content-type": "text/plain" } })),
  );
  f.host.convert.mockResolvedValueOnce(empty);
  await expect(read(f)).resolves.toEqual(empty);
  f.host.convert.mockRejectedValueOnce(new Error("invalid UTF-8"));
  await expect(read(f)).rejects.toThrow("invalid UTF-8");
  expect(f.browser.load).not.toHaveBeenCalled();
});

test.each(["status", "empty"])(
  "reports both failures when browser is missing after %s",
  async (mode) => {
    const f = fixture(
      mode === "empty"
        ? vi.fn(
            async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
          )
        : undefined,
    );
    f.host.convert.mockResolvedValueOnce(empty);
    f.browser.load.mockRejectedValue(
      new Error(
        "No system Chrome or Chromium executable was found. Install Chrome/Chromium or set PI_AGENT_IDE_BROWSER_PATH.",
      ),
    );
    await expect(read(f)).rejects.toThrow(
      /HTTP read failed .*browser fallback failed: .*PI_AGENT_IDE_BROWSER_PATH/,
    );
    expect(f.browser.load).toHaveBeenCalledOnce();
  },
);

test("does not return empty browser output as success", async () => {
  const f = fixture();
  f.host.convert.mockResolvedValue(empty);
  await expect(read(f)).rejects.toThrow("Browser read returned empty content");
  expect(f.browser.load).toHaveBeenCalledOnce();
});

test("caller cancellation prevents browser fallback", async () => {
  const controller = new AbortController();
  const f = fixture(
    vi.fn(async () => {
      controller.abort(new Error("cancelled"));
      throw controller.signal.reason;
    }),
  );
  await expect(read(f, controller.signal)).rejects.toThrow("cancelled");
  expect(f.browser.load).not.toHaveBeenCalled();
});

test("HTTP timeout gives the browser a fresh deadline", async () => {
  const f = fixture(
    vi.fn(
      (_url: string | URL | Request, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    ),
  );
  await expect(read(f, undefined, 20)).resolves.toEqual(rendered);
  expect(f.browser.load).toHaveBeenCalledOnce();
});
