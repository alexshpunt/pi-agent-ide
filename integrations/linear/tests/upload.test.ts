import { required } from "./fixtures/check.ts";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { encode } from "@toon-format/toon-v4";
import { beforeAll, expect, test, vi } from "vitest";
import { assetAddress, parseAssetAddress } from "#linear/asset-address.ts";
import { convertAsset } from "#linear/asset-content.ts";
import { createAxiUploader, createLinearUploadTool } from "#linear/upload.ts";
import { createLinearAssetResolver } from "#linear/asset-read.ts";

const asset = "https://uploads.linear.app/workspace/asset/proof.zip";
const reference = assetAddress("example", asset);
const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 0, 13, 10]);
const hash = createHash("sha256").update(bytes).digest("hex");
const receipt = {
  workspace: "example",
  upload: "applied" as const,
  filename: "proof.zip",
  size: bytes.length,
  sha256: hash,
  assetUrl: asset,
};

test("private addresses preserve workspace and refuse foreign/signed credential URLs before any read", () => {
  expect(parseAssetAddress(reference)).toEqual({
    workspace: "example",
    source: reference,
    url: asset,
  });
  expect(parseAssetAddress("https://example.org/file.zip")).toBeUndefined();
  for (const url of [
    "https://example.org/file",
    "http://uploads.linear.app/file",
    "https://user:secret@uploads.linear.app/file",
    `${asset}?signature=secret`,
  ])
    expect(() => assetAddress("example", url)).toThrow("LINEAR_INVALID_ASSET_URL");
});

test("uploader resolves explicit issue URL without passing credentials or silently selecting a parent", async () => {
  const run = vi.fn(async (_cwd: string, _args: readonly string[]) =>
    encode({
      upload: { ...receipt, attachment: { effect: "applied", id: "attachment", url: asset } },
    }),
  );
  const result = await createAxiUploader(run)(
    {
      workspace: "example",
      file: "proof.zip",
      issue: "https://linear.app/example/issue/ENG-12/proof",
      title: "Archive",
    },
    process.cwd(),
  );
  expect(run.mock.calls[0]?.[1]).toEqual([
    "assets",
    "upload",
    "--workspace",
    "example",
    "--file",
    "proof.zip",
    "--issue",
    "ENG-12",
    "--title",
    "Archive",
  ]);
  expect(result.read).toBe(reference);
  await expect(
    createAxiUploader(run)(
      {
        workspace: "other",
        file: "proof.zip",
        issue: "https://linear.app/example/issue/ENG-12/proof",
      },
      process.cwd(),
    ),
  ).rejects.toThrow("LINEAR_IDENTITY_MISMATCH");
  expect(run).toHaveBeenCalledTimes(1);
});

test("partial attachment error keeps uploaded asset and read links visible in the existing tool receipt", async () => {
  const tool = createLinearUploadTool(async () => ({
    ...receipt,
    read: reference,
    attachment: { effect: "not-applied", error: "LINEAR_PERMISSION_DENIED" },
  }));
  const result = await tool.execute(
    "test",
    { workspace: "example", file: "proof.zip", issue: "ENG-12" },
    new AbortController().signal,
    undefined,
    { cwd: process.cwd() } as Parameters<typeof tool.execute>[4],
  );
  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({
    effect: "applied",
    receipt: { assetUrl: asset, attachment: { effect: "not-applied" } },
  });
  const block = required(result.content[0]);
  expect(block.type === "text" && block.text).toContain(reference);
});

test("uncertain backend failure is sanitized and never replayed", async () => {
  const upload = vi.fn(async () => {
    throw new Error("secret token and signed URL");
  });
  const tool = createLinearUploadTool(upload);
  const result = await tool.execute(
    "test",
    { workspace: "example", file: "proof.zip" },
    new AbortController().signal,
    undefined,
    { cwd: process.cwd() } as Parameters<typeof tool.execute>[4],
  );
  expect(result.details).toMatchObject({ effect: "unknown" });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain("secret token");
  expect(upload).toHaveBeenCalledTimes(1);
});

// Asset Reads share one converter worker. Loading its module graph takes seconds on a loaded
// machine; pay it once here so each test's own budget covers only the behavior it checks.
beforeAll(async () => {
  await convertAsset("linear://example/asset", bytes);
}, 60_000);

function downloader(payload: Buffer = bytes) {
  let downloaded = "";
  const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
    downloaded = required(args.at(-1));
    await writeFile(downloaded, payload, { flag: "wx" });
    return encode({
      download: {
        workspace: "example",
        url: args[5],
        size: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
      },
    });
  });
  return { run, file: () => downloaded };
}

test("archive Read is lazy, explicit about no extraction, and supports exact original byte windows", async () => {
  const backend = downloader();
  const result = await createLinearAssetResolver(backend.run).tryResolve(reference, {
    cwd: process.cwd(),
  });
  expect(backend.run).not.toHaveBeenCalled();
  if (result.kind !== "resolved" || !result.resource.read || !result.resource.readBytes)
    throw new Error("Missing resource");
  expect(result.resource.write).toBeUndefined();
  const archive = await result.resource.read({});
  expect(archive).toHaveLength(1);
  const notice = archive.at(0);
  expect(notice?.type === "text" && notice.text).toContain(`raw:${reference}`);
  expect(await result.resource.readBytes(-3, 2, {})).toEqual({
    bytes: bytes.subarray(6, 8),
    byteOffset: 6,
    totalBytes: 9,
  });
  expect(backend.run).toHaveBeenCalledTimes(1);
  await expect(access(backend.file())).rejects.toMatchObject({ code: "ENOENT" });
});

// This test starts a cold Node process to build its PDF fixture, which takes seconds on a
// loaded machine, so it gets more than vitest's 5 s default.
test(
  "extensionless private PDF uses the shared converter and preserves original bytes",
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "linear-pdf-proof-"));
    try {
      await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("./fixtures/make-assets.mjs", import.meta.url)),
        directory,
      ]);
      const payload = await readFile(path.join(directory, "linear-verification.pdf"));
      const backend = downloader(payload);
      const source = assetAddress("example", "https://uploads.linear.app/workspace/asset/uuid");
      const result = await createLinearAssetResolver(backend.run).tryResolve(source, {
        cwd: process.cwd(),
      });
      if (result.kind !== "resolved" || !result.resource.read || !result.resource.readBytes)
        throw new Error("Missing PDF");
      const parsed = await result.resource.read({});
      expect(parsed).toHaveLength(1);
      const block = required(parsed[0]);
      const text = block.type === "text" ? block.text : undefined;
      expect(text).toContain("Linear artifact verification PDF");
      // The fixture is ASCII, so raw bytes decoded as text would also contain the phrase.
      expect(text).not.toContain("%PDF-");
      expect(result.resource.source).toBe(source);
      expect((await result.resource.readBytes(0, undefined, {})).bytes).toEqual(payload);
      expect(backend.run).toHaveBeenCalledTimes(1);
      await expect(access(backend.file())).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
test("malformed recognized images fail safely without hiding access to original bytes", async () => {
  const payload = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const backend = downloader(payload);
  const result = await createLinearAssetResolver(backend.run).tryResolve(reference, {
    cwd: process.cwd(),
  });
  if (result.kind !== "resolved" || !result.resource.read || !result.resource.readBytes)
    throw new Error("Missing resource");
  await expect(result.resource.read({})).rejects.toMatchObject({
    code: "LINEAR_ASSET_FORMAT_UNSUPPORTED",
    effect: "not-applied",
  });
  expect((await result.resource.readBytes(0, undefined, {})).bytes).toEqual(payload);
});
test("extensionless PNG uses the shared image converter without modifying raw bytes", async () => {
  const payload = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
  const backend = downloader(payload);
  const source = assetAddress("example", "https://uploads.linear.app/workspace/asset/uuid");
  const result = await createLinearAssetResolver(backend.run).tryResolve(source, {
    cwd: process.cwd(),
  });
  if (result.kind !== "resolved" || !result.resource.read || !result.resource.readBytes)
    throw new Error("Missing image");
  expect(await result.resource.read({})).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]),
  );
  expect((await result.resource.readBytes(0, undefined, {})).bytes).toEqual(payload);
});
