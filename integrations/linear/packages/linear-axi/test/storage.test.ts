/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { LinearStorageClient, MAX_ASSET_BYTES, privateAssetUrl } from "#axi/storage.ts";
import { fixtureRequestUrl, fixtureString } from "./fixtures/http.ts";
import { jsonRecord } from "./fixtures/json.ts";
import { fixtureGraphqlRequest } from "./fixtures/graphql-request.ts";
import { LinearPreflightCache } from "#axi/preflight-cache.ts";
import { LinearRateLimitError, rateLimitInfoFromError } from "#axi/rate-limit.ts";

const asset = "https://uploads.linear.app/workspace/asset/proof.zip";
const signed = "https://storage.example.org/upload?signature=private-signature";
const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 0, 13, 10]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
async function fixture(execute: (cwd: string) => Promise<void>) {
  await mkdir(".tmp", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/storage-"));
  try {
    await writeFile(path.join(cwd, "proof.zip"), bytes);
    await execute(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
function client(
  options: {
    workspace?: string;
    put?: "lost" | "redirect";
    attachment?: "denied" | "malformed";
    reservationDenied?: boolean;
    afterPut?: () => void;
    body?: Uint8Array;
    rateStage?: "reservation" | "put" | "attachment";
    contextStage?: "reservation" | "put" | "attachment";
  } = {},
) {
  const calls: Array<{
    url: string;
    init?: RequestInit;
    query?: string;
    variables?: Record<string, unknown>;
  }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const request = init?.method === "POST" ? fixtureGraphqlRequest(init) : undefined;
    calls.push({ url: fixtureRequestUrl(url), init, ...request });
    const response = (data: unknown) => new Response(JSON.stringify({ data }));
    const stage = request?.query.startsWith("mutation Upload")
      ? "reservation"
      : request?.query.startsWith("mutation Attach")
        ? "attachment"
        : init?.method === "PUT"
          ? "put"
          : undefined;
    if (stage && stage === options.rateStage)
      throw new LinearRateLimitError({
        retryAfterMs: 60000,
        resetAt: Date.now() + 60000,
        requestsRemaining: 0,
      });
    if (stage && stage === options.contextStage) throw new Error("LINEAR_AUTH_CONTEXT_CHANGED");
    if (request?.query.startsWith("query StorageScope"))
      return response({
        organization: { urlKey: options.workspace ?? "example" },
        issue: {
          id: "issue-uuid",
          identifier: "ENG-12",
          url: "https://linear.app/example/issue/ENG-12/proof",
        },
      });
    if (request?.query.startsWith("mutation Upload")) {
      if (options.reservationDenied)
        return new Response(
          JSON.stringify({
            errors: [{ message: "fixture-secret", extensions: { code: "FORBIDDEN" } }],
          }),
          { status: 400 },
        );
      return response({
        fileUpload: {
          success: true,
          uploadFile: {
            uploadUrl: signed,
            assetUrl: asset,
            headers: [{ key: "x-upload-token", value: "upload-only" }],
          },
        },
      });
    }
    if (init?.method === "PUT") {
      assert.equal(fixtureRequestUrl(url), signed);
      assert.deepEqual(Buffer.from(init.body as Uint8Array), bytes);
      options.afterPut?.();
      if (options.put === "lost") throw new Error("fixture-secret private-signature");
      return new Response(null, { status: options.put === "redirect" ? 302 : 200 });
    }
    if (request?.query.startsWith("mutation Attach")) {
      if (options.attachment === "denied") return new Response("fixture-secret", { status: 403 });
      return response({
        attachmentCreate: {
          success: true,
          attachment: {
            ...(options.attachment === "malformed" ? {} : { id: "attachment-uuid" }),
            url: asset,
          },
        },
      });
    }
    if (fixtureRequestUrl(url) === asset)
      return new Response(Uint8Array.from(options.body ?? bytes));
    throw new Error("Unexpected fixture request");
  };
  const instance = new LinearStorageClient({
    fetchImpl,
    tokenProvider: { getToken: async () => "fixture-secret" },
  });
  return { instance, calls };
}

void test("upload preserves exact bytes and uses only signed PUT headers, without implicit attachment", async () =>
  fixture(async (cwd) => {
    const { instance, calls } = client();
    const result = await instance.upload({ cwd, file: "proof.zip", workspace: "example" });
    assert.deepEqual(result, {
      workspace: "example",
      filename: "proof.zip",
      size: bytes.length,
      sha256,
      assetUrl: asset,
      upload: "applied",
    });
    assert.equal(calls.length, 3);
    assert.match(fixtureString(calls[1].query), /makePublic: false/);
    const headers = new Headers(calls[2].init?.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("x-upload-token"), "upload-only");
    assert.equal(calls[2].init?.redirect, "error");
    assert.ok(!JSON.stringify(result).includes("private-signature"));
  }));

void test("HTTP 400 GraphQL permission errors remain explicit and never reach PUT", async () =>
  fixture(async (cwd) => {
    const { instance, calls } = client({ reservationDenied: true });
    const result = await instance.upload({
      cwd,
      file: "proof.zip",
      workspace: "example",
      issue: "ENG-12",
    });
    assert.equal(result.upload, "not-applied");
    assert.equal(result.error, "LINEAR_PERMISSION_DENIED");
    assert.equal(result.assetUrl, undefined);
    assert.equal(result.attachment, undefined);
    assert.equal(calls.length, 2);
    assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  }));
void test("explicit issue attachment uses its verified UUID and preserves the uploaded URL", async () =>
  fixture(async (cwd) => {
    const { instance, calls } = client();
    const result = await instance.upload({
      cwd,
      file: "proof.zip",
      workspace: "example",
      issue: "ENG-12",
      title: "Test ZIP",
    });
    assert.deepEqual(calls[3].variables, {
      input: { issueId: "issue-uuid", title: "Test ZIP", url: asset },
    });
    assert.deepEqual(result.attachment, { id: "attachment-uuid", effect: "applied", url: asset });
  }));

void test("permission failure attaching cannot hide the completed upload", async () =>
  fixture(async (cwd) => {
    const { instance, calls } = client({ attachment: "denied" });
    const result = await instance.upload({
      cwd,
      file: "proof.zip",
      workspace: "example",
      issue: "ENG-12",
    });
    assert.equal(result.upload, "applied");
    assert.equal(result.assetUrl, asset);
    assert.deepEqual(result.attachment, {
      effect: "not-applied",
      error: "LINEAR_PERMISSION_DENIED",
    });
    assert.equal(calls.length, 4);
    assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  }));

void test("malformed acknowledged attachment stays unknown, never a clean rejection", async () =>
  fixture(async (cwd) => {
    const { instance } = client({ attachment: "malformed" });
    const result = await instance.upload({
      cwd,
      file: "proof.zip",
      workspace: "example",
      issue: "ENG-12",
    });
    assert.equal(result.upload, "applied");
    assert.equal(result.attachment?.effect, "unknown");
  }));

for (const put of ["lost", "redirect"] as const) {
  void test(`uncertain PUT (${put}) is not replayed or followed by attachment`, async () =>
    fixture(async (cwd) => {
      const { instance, calls } = client({ put });
      const result = await instance.upload({
        cwd,
        file: "proof.zip",
        workspace: "example",
        issue: "ENG-12",
      });
      assert.equal(result.upload, "unknown");
      assert.equal(result.assetUrl, asset);
      assert.equal(result.attachment, undefined);
      assert.equal(result.error, "LINEAR_UPLOAD_PUT_FAILED");
      assert.equal(calls.length, 3);
      assert.ok(!JSON.stringify(result).includes("private-signature"));
    }));
}

void test("wrong workspace rejects before any storage mutation", async () =>
  fixture(async (cwd) => {
    const { instance, calls } = client({ workspace: "other" });
    await assert.rejects(
      () => instance.upload({ cwd, file: "proof.zip", workspace: "example" }),
      /LINEAR_IDENTITY_MISMATCH/,
    );
    assert.equal(calls.length, 1);
  }));

void test("large local file refuses before native authorization or upload", async () =>
  fixture(async (cwd) => {
    await truncate(path.join(cwd, "proof.zip"), MAX_ASSET_BYTES + 1);
    const { instance, calls } = client();
    await assert.rejects(
      () => instance.upload({ cwd, file: "proof.zip", workspace: "example" }),
      /LINEAR_FILE_UNSUPPORTED_OR_TOO_LARGE/,
    );
    assert.equal(calls.length, 0);
  }));

void test("cancellation before upload has no network effect", async () =>
  fixture(async (cwd) => {
    const { instance, calls } = client();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() =>
      instance.upload({ cwd, file: "proof.zip", workspace: "example", signal: controller.signal }),
    );
    assert.equal(calls.length, 0);
  }));

void test("cancellation after PUT preserves the completed upload separately", async () =>
  fixture(async (cwd) => {
    const controller = new AbortController();
    const { instance, calls } = client({ afterPut: () => controller.abort() });
    const result = await instance.upload({
      cwd,
      file: "proof.zip",
      workspace: "example",
      issue: "ENG-12",
      signal: controller.signal,
    });
    assert.equal(result.upload, "applied");
    assert.equal(result.assetUrl, asset);
    assert.notEqual(result.attachment?.effect, "applied");
    assert.equal(calls.length, 3);
  }));

void test("private authorized download preserves original bytes and does not overwrite a local file", async () =>
  fixture(async (cwd) => {
    const { instance, calls } = client();
    const output = path.join(cwd, "download.zip");
    assert.deepEqual(await instance.download({ workspace: "example", url: asset, output }), {
      size: bytes.length,
      sha256,
    });
    assert.deepEqual(await readFile(output), bytes);
    assert.equal(new Headers(calls[1].init?.headers).get("authorization"), "Bearer fixture-secret");
    assert.equal(calls[1].init?.redirect, "error");
    await assert.rejects(() => instance.download({ workspace: "example", url: asset, output }));
    assert.deepEqual(await readFile(output), bytes);
  }));

for (const url of [
  "https://example.org/file",
  "http://uploads.linear.app/file",
  "https://user:secret@uploads.linear.app/file",
  "https://uploads.linear.app/file?token=secret",
]) {
  void test(`private reader refuses credential forwarding to ${url}`, () =>
    assert.throws(() => privateAssetUrl(url), /LINEAR_INVALID_ASSET_URL/));
}

for (const status of [429, 400]) {
  void test(`storage retains safe HTTP ${status} rate timing and shares the cooldown across clients`, async () =>
    fixture(async (cwd) => {
      const endpoint = "https://api.linear.app/graphql";
      let calls = 0;
      const fetchImpl: typeof fetch = async () => {
        calls++;
        return new Response(
          JSON.stringify({
            errors: [{ message: "storage-private-body", extensions: { code: "RATELIMITED" } }],
          }),
          {
            status,
            headers: { "retry-after": "60", "x-private-header": "storage-private-header" },
          },
        );
      };
      const create = () => {
        const cache = new LinearPreflightCache({
          directory: path.join(cwd, "preflight"),
          scope: async () => ({
            connectionId: "fixture",
            epoch: "one",
            server: "https://mcp.example.test/mcp",
          }),
        });
        return new LinearStorageClient({
          tokenProvider: {
            getToken: async () => "storage-private-token",
          },
          fetchImpl: (input, init) => cache.fetch(input, init, fetchImpl),
          onRateLimit: (headers) => cache.rateLimited(endpoint, headers),
        });
      };
      let firstReset: number | undefined;
      for (const instance of [create(), create()]) {
        await assert.rejects(
          instance.download({
            workspace: "example",
            url: asset,
            output: path.join(cwd, "absent.zip"),
          }),
          (error: unknown) => {
            assert(error instanceof Error);
            assert.equal(error.message, "LINEAR_RATE_LIMITED");
            const info = rateLimitInfoFromError(error);
            assert(info?.retryAfterMs && info.retryAfterMs <= 60000 && info.retryAfterMs > 50000);
            assert(info.resetAt);
            if (firstReset) assert.equal(info.resetAt, firstReset);
            else firstReset = info.resetAt;
            const encoded = JSON.stringify(error);
            for (const secret of [
              "storage-private-body",
              "storage-private-header",
              "storage-private-token",
            ])
              assert(!encoded.includes(secret));
            return true;
          },
        );
      }
      assert.equal(calls, 1);
      await assert.rejects(readFile(path.join(cwd, "absent.zip")), { code: "ENOENT" });
    }));
}

void test("a private asset's rate failure retains metadata without replaying that endpoint", async () =>
  fixture(async (cwd) => {
    let assetCalls = 0;
    const create = () => {
      const cache = new LinearPreflightCache({
        directory: path.join(cwd, "asset-preflight"),
        scope: async () => ({
          connectionId: "fixture",
          epoch: "one",
          server: "https://mcp.example.test/mcp",
        }),
      });
      return new LinearStorageClient({
        tokenProvider: {
          getToken: async () => "storage-private-token",
        },
        fetchImpl: (input, init) =>
          cache.fetch(input, init, async (target) => {
            if (fixtureRequestUrl(target) !== asset)
              return new Response(
                JSON.stringify({ data: { organization: { urlKey: "example" } } }),
              );
            assetCalls++;
            return new Response("storage-private-body", {
              status: 429,
              headers: { "retry-after": "60" },
            });
          }),
      });
    };
    for (const instance of [create(), create()])
      await assert.rejects(
        instance.download({
          workspace: "example",
          url: asset,
          output: path.join(cwd, "absent.zip"),
        }),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.equal(error.message, "LINEAR_RATE_LIMITED");
          assert(rateLimitInfoFromError(error)?.retryAfterMs);
          assert(!JSON.stringify(error).includes("storage-private-body"));
          return true;
        },
      );
    assert.equal(assetCalls, 1);
  }));

for (const stage of ["reservation", "put", "attachment"] as const) {
  void test(`a rate-limited ${stage} retains safe metadata and independent upload effects`, async () =>
    fixture(async (cwd) => {
      const { instance, calls } = client({ rateStage: stage });
      const receipt = await instance.upload({
        cwd,
        file: "proof.zip",
        workspace: "example",
        issue: "ENG-12",
      });
      assert.equal(
        receipt.upload,
        stage === "attachment" ? "applied" : stage === "put" ? "unknown" : "not-applied",
      );
      const outcome = stage === "attachment" ? receipt.attachment : receipt;
      assert(outcome);
      assert.equal(outcome.error, "LINEAR_RATE_LIMITED");
      if (stage === "attachment") assert.equal(receipt.attachment?.effect, "unknown");
      const info = jsonRecord(outcome.rateLimit);
      assert.equal(info.retryAfterMs, 60000);
      assert.equal(info.requestsRemaining, 0);
      assert.equal(calls.length, stage === "reservation" ? 2 : stage === "put" ? 3 : 4);
      assert(!JSON.stringify(receipt).includes("fixture-secret"));
      assert(!JSON.stringify(receipt).includes("private-signature"));
    }));
  void test(`a changed authorization context during ${stage} is not replaced by a generic failure`, async () =>
    fixture(async (cwd) => {
      const { instance, calls } = client({ contextStage: stage });
      const receipt = await instance.upload({
        cwd,
        file: "proof.zip",
        workspace: "example",
        issue: "ENG-12",
      });
      const outcome = stage === "attachment" ? receipt.attachment : receipt;
      assert.equal(outcome?.error, "LINEAR_AUTH_CONTEXT_CHANGED");
      assert.equal(
        receipt.upload,
        stage === "attachment" ? "applied" : stage === "put" ? "unknown" : "not-applied",
      );
      assert.equal(calls.length, stage === "reservation" ? 2 : stage === "put" ? 3 : 4);
    }));
}

void test("download preserves an authorization-context refusal from the fetch boundary", async () =>
  fixture(async (cwd) => {
    const instance = new LinearStorageClient({
      tokenProvider: { getToken: async () => "synthetic" },
      fetchImpl: async () => {
        throw new Error("LINEAR_AUTH_CONTEXT_CHANGED");
      },
    });
    await assert.rejects(
      instance.download({ workspace: "example", url: asset, output: path.join(cwd, "absent.zip") }),
      { message: "LINEAR_AUTH_CONTEXT_CHANGED" },
    );
  }));
