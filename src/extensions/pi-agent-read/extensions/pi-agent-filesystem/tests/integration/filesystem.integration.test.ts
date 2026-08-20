import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import type {
  AgentContent,
  ContentHost,
  ContentInput,
  Resource,
  ResourceResolver,
} from "pi-agent-resource";

import { createFilesystemReadResolver, createFilesystemWriteResolver } from "#src/resolver.js";

const tempRoot = path.resolve(".tmp/pi-agent-filesystem");

const convertedContent: AgentContent = [{ type: "text", text: "converted by test host" }];

test("reads relative, absolute, and empty files as opaque bytes", async () => {
  await withTempDirectory(async (directory) => {
    const workspace = path.join(directory, "workspace");
    const relative = path.join(workspace, "relative.data");
    const outside = path.join(directory, "outside.data");
    const empty = path.join(workspace, "empty.data");
    await mkdir(workspace);
    await writeFile(relative, Buffer.from([0x00, 0x7f, 0xff]));
    await writeFile(outside, Buffer.from([0x10, 0x20]));
    await writeFile(empty, Buffer.alloc(0));

    const inputs: ContentInput[] = [];
    const resolver = createFilesystemReadResolver(recordingContentHost(inputs));
    const relativeResource = await resolveReadable(resolver, "relative.data", workspace);
    const absoluteResource = await resolveReadable(resolver, outside, workspace);
    const emptyResource = await resolveReadable(resolver, "empty.data", workspace);

    expect(relativeResource.source).toBe(relative);
    expect(relativeResource.write).toBeUndefined();
    await expect(relativeResource.read?.({})).resolves.toEqual(convertedContent);
    await expect(absoluteResource.read?.({})).resolves.toEqual(convertedContent);
    await expect(emptyResource.read?.({})).resolves.toEqual(convertedContent);
    expect(
      inputs.map((input) => ({
        source: input.source,
        bytes: Buffer.from(input.bytes).toString("hex"),
      })),
    ).toEqual([
      { source: relative, bytes: "007fff" },
      { source: outside, bytes: "1020" },
      { source: empty, bytes: "" },
    ]);
  });
});

test("keeps read and write capabilities on separate resources", async () => {
  await withTempDirectory(async (directory) => {
    const file = path.join(directory, "writable.data");
    await writeFile(file, "before\n", "utf8");
    const readResolver = createFilesystemReadResolver(fixedContentHost("read content"));
    const writeResolver = createFilesystemWriteResolver(fixedContentHost("write content"));
    const readAttempt = await readResolver.tryResolve("writable.data", { cwd: directory });
    const writeAttempt = await writeResolver.tryResolve("writable.data", { cwd: directory });

    expect(readAttempt.kind).toBe("resolved");
    expect(writeAttempt.kind).toBe("resolved");

    if (readAttempt.kind !== "resolved" || writeAttempt.kind !== "resolved") {
      throw new Error("Filesystem resolvers did not resolve the fixture");
    }

    expect(readAttempt.resource.write).toBeUndefined();
    expect(writeAttempt.resource.read).toBeTypeOf("function");
    expect(writeAttempt.resource.write).toBeTypeOf("function");
    await expect(readAttempt.resource.read?.({})).resolves.toEqual([
      { type: "text", text: "read content" },
    ]);
    await expect(writeAttempt.resource.read?.({})).resolves.toEqual([
      { type: "text", text: "write content" },
    ]);

    if (writeAttempt.resource.write === undefined) {
      throw new Error("Write resolver did not return a writable resource");
    }

    await expect(
      writeAttempt.resource.write([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], {}),
    ).rejects.toThrow("exactly one text block");
    await writeAttempt.resource.write([{ type: "text", text: "after\n" }], {});
    await expect(readFile(file, "utf8")).resolves.toBe("after\n");
  });
});

test("creates parent directories when writing a new nested file", async () => {
  await withTempDirectory(async (directory) => {
    const file = path.join(directory, "nested", "deeper", "created.data");
    const resolver = createFilesystemWriteResolver(fixedContentHost("nested content"));
    const attempt = await resolver.tryResolve("nested/deeper/created.data", { cwd: directory });

    if (attempt.kind !== "resolved" || attempt.resource.write === undefined) {
      throw new Error("Filesystem resolver did not return a writable resource");
    }

    await attempt.resource.write([{ type: "text", text: "created content\n" }], {});

    await expect(readFile(file, "utf8")).resolves.toBe("created content\n");
  });
});

test("does not claim explicit non-filesystem references", async () => {
  const resolver = createFilesystemReadResolver(fixedContentHost("unused"));

  await expect(
    resolver.tryResolve("https://example.com/file.txt", { cwd: "/workspace" }),
  ).resolves.toEqual({ kind: "not-handled" });
});

function recordingContentHost(inputs: ContentInput[]): Pick<ContentHost, "convert"> {
  return {
    convert(input): Promise<AgentContent> {
      inputs.push({ ...input, bytes: Uint8Array.from(input.bytes) });
      return Promise.resolve(convertedContent);
    },
  };
}

function fixedContentHost(value: string): Pick<ContentHost, "convert"> {
  return {
    convert(): Promise<AgentContent> {
      return Promise.resolve([{ type: "text", text: value }]);
    },
  };
}

async function resolveReadable(
  resolver: ResourceResolver,
  source: string,
  cwd: string,
): Promise<Resource> {
  const attempt = await resolver.tryResolve(source, { cwd });

  if (attempt.kind !== "resolved" || attempt.resource.read === undefined) {
    throw new Error(`Filesystem resolver did not return a readable Resource for ${source}`);
  }

  return attempt.resource;
}

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, "filesystem-"));

  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
