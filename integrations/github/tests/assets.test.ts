import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GithubRequestCoordinator } from "#github/request-coordinator.ts";
import { GithubAssets } from "#github/assets.ts";
import { parseGithubAddress } from "#github/address.ts";
import type { GithubCredentials } from "#github/client.ts";
import { githubPackageRoot } from "./fixtures/package-root.ts";

const token = "private-installation-token";
const maximumBytes = 25 * 1024 * 1024;
const downloadSource = "github://owner/repo/releases/assets/41";
const uploadSource = "github://owner/repo/releases/7/assets/new";
let directory: string;
let file: string;
beforeEach(async () => {
  await mkdir(path.join(githubPackageRoot, ".tmp"), { recursive: true });
  directory = await mkdtemp(path.join(githubPackageRoot, ".tmp/assets-"));
  file = path.join(directory, "fixture.bin");
  await writeFile(file, Buffer.from([0, 255, 1, 2]), { mode: 0o600 });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fixture(
  options: {
    bytes?: Uint8Array;
    release?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    fetcher?: typeof fetch;
  } = {},
) {
  const bytes = options.bytes ?? new Uint8Array([0, 255, 1, 2]);
  const metadata = {
    id: 41,
    name: "fixture.bin",
    size: bytes.length,
    content_type: "application/octet-stream",
    url: "https://api.github.com/repos/owner/repo/releases/assets/41",
    browser_download_url: "https://github.com/owner/repo/releases/download/fixture/fixture.bin",
    ...options.metadata,
  };
  const release = {
    id: 7,
    draft: true,
    upload_url: "https://uploads.github.com/repos/owner/repo/releases/7/assets{?name,label}",
    ...options.release,
  };
  const credentials: GithubCredentials = {
    initialize: vi.fn(async () => undefined),
    getToken: vi.fn(async () => ({ token, expiresAt: Date.now() + 3_600_000 })),
    identity: {
      login: "fixture[bot]",
      name: "fixture[bot]",
      email: "1+fixture[bot]@users.noreply.github.com",
    },
  };
  const rest = vi.fn(async (_method: string, route: string) => ({
    data: route.endsWith("/releases/7") ? release : metadata,
  }));
  const coordinator = new GithubRequestCoordinator({ directory: null, mutationIntervalMs: 0 });
  const fetcher =
    options.fetcher ??
    vi.fn<typeof fetch>(async (_url, request) => {
      return request?.method === "POST"
        ? new Response(JSON.stringify(metadata), { status: 201 })
        : new Response(Uint8Array.from(bytes));
    });
  const assets = new GithubAssets(
    async () => credentials,
    async () => ({ rest, coordinator }),
    { fetcher, coordinator },
  );
  return { assets, credentials, rest, fetcher, metadata };
}
function uploadAddress() {
  const address = parseGithubAddress(uploadSource);
  assert.ok(address);
  return address;
}
async function resource(assets: GithubAssets) {
  const result = await assets.resolver().tryResolve(downloadSource, { cwd: directory });
  if (result.kind !== "resolved") throw new Error("fixture was not resolved");
  const { read, readBytes } = result.resource;
  assert.ok(read && readBytes);
  return { read, readBytes };
}
function input(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ file: "fixture.bin", name: "fixture.bin", ...overrides });
}

describe("GitHub release asset boundary", () => {
  test("uploads the exact original bytes and verifies the canonical asset receipt", async () => {
    const { assets, fetcher, rest } = fixture();
    const address = uploadAddress();
    expect(assets.owns(address)).toBe(true);
    const schema: unknown = JSON.parse(assets.readSchema(address));
    expect(schema).toMatchObject({ input: { required: ["file", "name"] } });
    const receipt = await assets.upload(address, input({ label: "test fixture" }), directory);
    expect(receipt).toMatchObject({ source: downloadSource, id: "41", effect: "applied" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = vi.mocked(fetcher).mock.calls.at(0);
    assert.ok(request);
    expect(request[0]).toBe(
      "https://uploads.github.com/repos/owner/repo/releases/7/assets?name=fixture.bin&label=test+fixture",
    );
    expect(request[1]).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/octet-stream" },
    });
    const body = request[1]?.body;
    assert.ok(body instanceof Uint8Array);
    expect(Buffer.from(body)).toEqual(Buffer.from([0, 255, 1, 2]));
    expect(rest).toHaveBeenLastCalledWith(
      "GET",
      "/repos/owner/repo/releases/assets/41",
      undefined,
      expect.any(AbortSignal),
    );
  });

  test.each([
    "https://uploads.github.com.evil.test/repos/owner/repo/releases/7/assets",
    "http://uploads.github.com/repos/owner/repo/releases/7/assets",
    "https://user:secret@uploads.github.com/repos/owner/repo/releases/7/assets",
    "https://uploads.github.com:8443/repos/owner/repo/releases/7/assets",
    "https://uploads.github.com/repos/owner/other/releases/7/assets",
    "https://uploads.github.com/repos/owner/repo/releases/8/assets",
    "https://uploads.github.com/repos/owner/repo/releases/7/assets?secret=private",
    "https://uploads.github.com/repos/owner/repo/releases/7/assets#secret",
  ])("refuses untrusted upload URL without dispatch: %s", async (upload_url) => {
    const { assets, fetcher } = fixture({ release: { upload_url } });
    const error = await assets
      .upload(uploadAddress(), input(), directory)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GH_INVALID_UPLOAD_URL", effect: "not-applied" });
    expect(String(error)).not.toContain("secret");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("requires exact approval for a published release, but not a draft", async () => {
    const { assets, fetcher } = fixture({ release: { draft: false } });
    const address = uploadAddress();
    await expect(assets.upload(address, input(), directory)).rejects.toMatchObject({
      code: "GH_APPROVAL_REQUIRED",
      effect: "not-applied",
    });
    expect(fetcher).not.toHaveBeenCalled();
    const approval = vi.fn(async () => true);
    await expect(
      assets.upload(address, input(), directory, undefined, approval),
    ).resolves.toMatchObject({ effect: "applied" });
    expect(approval).toHaveBeenCalledWith(uploadSource, "upload release asset");
  });

  test("refuses symlinks, non-files and oversized local files before remote access", async () => {
    const { assets, fetcher, rest } = fixture();
    const address = uploadAddress();
    await symlink(file, path.join(directory, "link.bin"));
    await expect(
      assets.upload(address, input({ file: "link.bin" }), directory),
    ).rejects.toMatchObject({ code: "GH_ASSET_FILE_INVALID", effect: "not-applied" });
    await expect(assets.upload(address, input({ file: "." }), directory)).rejects.toMatchObject({
      code: "GH_ASSET_FILE_INVALID",
      effect: "not-applied",
    });
    await truncate(file, maximumBytes + 1);
    await expect(assets.upload(address, input(), directory)).rejects.toMatchObject({
      code: "GH_ASSET_TOO_LARGE",
      effect: "not-applied",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(rest).not.toHaveBeenCalled();
  });

  test("returns original raw byte windows and does not invent binary/archive text", async () => {
    const { assets, fetcher } = fixture();
    const asset = await resource(assets);
    const raw = await asset.readBytes(-2, undefined, {});
    expect([...raw.bytes]).toEqual([1, 2]);
    expect(raw).toMatchObject({ byteOffset: 2, totalBytes: 4 });
    const content = await asset.read({});
    expect(content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(content)).toContain("raw:" + downloadSource);
    expect(JSON.stringify(content)).toContain("not extracted");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const zipped = await resource(
      fixture({ bytes: new TextEncoder().encode("PK fake archive") }).assets,
    );
    expect(JSON.stringify(await zipped.read({}))).toContain("not extracted");
  });

  test("decodes safe UTF-8 text but excludes PDF bytes from text decoding", async () => {
    const asset = await resource(
      fixture({ bytes: new TextEncoder().encode("hello asset\n") }).assets,
    );
    expect(JSON.stringify(await asset.read({}))).toContain("hello asset");
    const pdf = await resource(
      fixture({ bytes: new TextEncoder().encode("%PDF-1.7 fake PDF") }).assets,
    );
    expect(JSON.stringify(await pdf.read({}))).toContain("not extracted");
  });

  test("renders a safe extensionless PNG without changing original bytes", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    );
    const asset = await resource(fixture({ bytes }).assets);
    const content = await asset.read({});
    expect(
      content.some(
        (block) => block.type === "image" && ["image/png", "image/jpeg"].includes(block.mimeType),
      ),
    ).toBe(true);
    expect(Buffer.from((await asset.readBytes(0, undefined, {})).bytes)).toEqual(bytes);
  });
  test("strips bearer credentials at the signed CDN boundary", async () => {
    const bytes = new Uint8Array([0, 255, 1, 2]);
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      (typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      ).startsWith("https://api.github.com/")
        ? new Response(null, {
            status: 302,
            headers: {
              Location: "https://release-assets.githubusercontent.com/path?signature=cdn-secret",
            },
          })
        : new Response(bytes),
    );
    const asset = await resource(fixture({ fetcher }).assets);
    expect([...(await asset.readBytes(0, undefined, {})).bytes]).toEqual([...bytes]);
    expect(fetcher.mock.calls.at(0)?.[1]).toMatchObject({
      redirect: "manual",
      headers: { Authorization: "Bearer " + token, Accept: "application/octet-stream" },
    });
    const cdnRequest = fetcher.mock.calls.at(1)?.[1];
    assert.ok(cdnRequest);
    expect(new Headers(cdnRequest.headers).has("authorization")).toBe(false);
    expect(JSON.stringify(await asset.read({}))).not.toContain("cdn-secret");
  });

  test.each([
    "https://evil.test/download?signature=secret",
    "http://objects.githubusercontent.com/asset",
    "https://objects.githubusercontent.com.evil.test/asset",
    "https://secret@release-assets.githubusercontent.com/asset",
    "https://api.github.com/repos/owner/other/releases/assets/41",
  ])("refuses unsafe download redirects without leaking their URLs: %s", async (location) => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: location } }),
    );
    const asset = await resource(fixture({ fetcher }).assets);
    const error = await asset.readBytes(0, undefined, {}).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GH_INVALID_DOWNLOAD_URL", effect: "not-applied" });
    expect(String(error)).not.toContain("secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("bounds streamed bytes and redirect count", async () => {
    let cancelled = false;
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(maximumBytes + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const asset = await resource(fixture({ fetcher }).assets);
    await expect(asset.readBytes(0, undefined, {})).rejects.toMatchObject({
      code: "GH_ASSET_TOO_LARGE",
      effect: "not-applied",
    });
    expect(cancelled).toBe(true);
    const redirects = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://objects.githubusercontent.com/again" },
        }),
    );
    await expect(
      (await resource(fixture({ fetcher: redirects }).assets)).readBytes(0, undefined, {}),
    ).rejects.toMatchObject({ code: "GH_ASSET_REDIRECT_LIMIT", effect: "not-applied" });
    expect(redirects).toHaveBeenCalledTimes(4);
  });

  test("checks metadata identity and the downloaded byte count", async () => {
    const mismatched = await resource(fixture({ metadata: { id: 99 } }).assets);
    await expect(mismatched.readBytes(0, undefined, {})).rejects.toMatchObject({
      code: "GH_ASSET_IDENTITY_MISMATCH",
      effect: "not-applied",
    });
    const short = await resource(fixture({ metadata: { size: 5 } }).assets);
    await expect(short.readBytes(0, undefined, {})).rejects.toMatchObject({
      code: "GH_ASSET_SIZE_MISMATCH",
      effect: "not-applied",
    });
  });

  test("classifies failed, redirected and unverified uploads as unknown without replay", async () => {
    for (const response of [
      () => {
        throw new Error(token);
      },
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.test/?secret=hidden" },
        }),
      () => new Response("server-secret", { status: 502 }),
      () => new Response("not JSON", { status: 201 }),
      () => new Response(JSON.stringify({ id: 99, name: "fixture.bin", size: 4 }), { status: 201 }),
    ]) {
      const fetcher = vi.fn(async () => response());
      const { assets } = fixture({ fetcher });
      const error = await assets
        .upload(uploadAddress(), input(), directory)
        .catch((value: unknown) => value);
      expect(error).toMatchObject({ effect: "unknown" });
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain("secret");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  test("cancellation before upload dispatch refuses locally; after dispatch it stays unknown", async () => {
    const address = uploadAddress();
    const fresh = fixture();
    await expect(
      fresh.assets.upload(address, input(), directory, AbortSignal.abort(token)),
    ).rejects.toMatchObject({ code: "GH_CANCELLED", effect: "not-applied" });
    expect(fresh.fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      controller.abort(token);
      return new Response("{}", { status: 201 });
    });
    await expect(
      fixture({ fetcher }).assets.upload(address, input(), directory, controller.signal),
    ).rejects.toMatchObject({ code: "GH_CANCELLED", effect: "unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("interrupts a pending download and redacts caller cancellation reasons", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      controller.abort(token);
      return new Promise<Response>(() => undefined);
    });
    const asset = await resource(fixture({ fetcher }).assets);
    const error = await asset
      .readBytes(0, undefined, { signal: controller.signal })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "GH_CANCELLED", effect: "not-applied" });
    expect(String(error)).not.toContain(token);
  });
});
