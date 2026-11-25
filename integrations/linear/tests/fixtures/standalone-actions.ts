import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { encode } from "@toon-format/toon-v4";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createStandaloneResources } from "#linear/standalone-resources.ts";
import { registerStandaloneTools } from "#linear/standalone-tools.ts";
import { createLinearTextBackend } from "#linear/text-backend.ts";
import { createLinearTextResolver } from "#linear/text-resource.ts";
import { createLinearArtifactBackend } from "#linear/artifact-backend.ts";
import {
  createLinearArtifactHandlers,
  createLinearArtifactResolver,
} from "#linear/artifact-actions.ts";
import {
  connectLinearPermissionGate,
  createLinearOperationHandlers,
} from "#linear/operation-actions.ts";
import { createAxiUploader, createLinearUploadTool } from "#linear/upload.ts";
import { loadLinearGuides } from "#linear/guidance.ts";
import type { LinearOperationBackend } from "#linear/operation-backend.ts";

const documentId = "11111111-1111-4111-8111-111111111111";
const unknownDocument = "33333333-3333-4333-8333-333333333333";
const issueUuid = "22222222-2222-4222-8222-222222222222";
const documentUrl = (id: string) =>
  `https://linear.app/example/document/fixture-${id.replaceAll("-", "").slice(-12)}`;

/** Only backend transport and the human answer are controlled; the tools and handlers are production. */
export default async function standaloneActions(pi: ExtensionAPI) {
  const documents: Record<
    string,
    { id: string; title: string; url: string; content: string; issueId: string }
  > = {
    [documentId]: {
      id: documentId,
      title: "Original",
      url: documentUrl(documentId),
      content: "Alpha\nBeta\nGamma\n",
      issueId: issueUuid,
    },
    [unknownDocument]: {
      id: unknownDocument,
      title: "Uncertain",
      url: documentUrl(unknownDocument),
      content: "Original unknown\n",
      issueId: issueUuid,
    },
  };
  const attachments: { id: string; title: string; url: string }[] = [];
  const state = {
    documents,
    attachments,
    textWrites: [] as { id: string; content: string }[],
    links: [] as unknown[],
    renames: [] as unknown[],
    deletions: [] as string[],
    uploads: [] as {
      issue: string | undefined;
      file: string;
      size: number;
      sha256: string;
      base64: string;
    }[],
    decisions: [] as { message: string; approved: boolean }[],
    waiting: [] as unknown[],
  };
  pi.events.on("herdr:blocked", (value) => state.waiting.push(value));
  pi.on("tool_call", (_event, context) => {
    context.ui.confirm = async (_title, message, options) => {
      const before = state.deletions.length;
      if (context.mode === "tui")
        assert.equal((state.waiting.at(-1) as { active?: boolean })?.active, true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(state.deletions.length, before, "Delete dispatched before the human answered");
      const approved = !message.includes("/refuse") && !options?.signal?.aborted;
      state.decisions.push({ message, approved });
      return approved;
    };
  });
  const run = async (
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> => {
    signal?.throwIfAborted();
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    if (args[0] === "documents" && args[1] === "view") {
      const document = documents[args[2]];
      assert(document, "Unexpected document read");
      return encode({ document });
    }
    if (args[0] === "documents" && args[1] === "update") {
      const id = value("--id");
      const document = documents[id];
      assert(document, "Unexpected document write");
      const content = await readFile(value("--content-file"), "utf8");
      document.content = content;
      state.textWrites.push({ id, content });
      if (id === unknownDocument) throw new Error("LINEAR_TRANSPORT_UNKNOWN");
      return "saved: true";
    }
    if (args[0] === "assets" && args[1] === "upload") {
      assert.equal(value("--workspace"), "example");
      const file = path.resolve(cwd, value("--file"));
      const metadata = await lstat(file);
      assert(metadata.isFile() && !metadata.isSymbolicLink(), "Unexpected upload source");
      const bytes = await readFile(file);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const issue = args.includes("--issue") ? value("--issue") : undefined;
      assert.equal(issue, "ENG-12", "Uploads require the explicit fixture issue");
      state.uploads.push({
        issue,
        file: path.basename(file),
        size: bytes.length,
        sha256,
        base64: bytes.toString("base64"),
      });
      const assetUrl = `https://uploads.linear.app/fixture/assets/${path.basename(file)}`;
      const uncertain = path.basename(file) === "uncertain.bin";
      return encode({
        upload: {
          workspace: "example",
          upload: "applied",
          filename: path.basename(file),
          size: bytes.length,
          sha256,
          assetUrl,
          attachment: uncertain
            ? { effect: "unknown", error: "LINEAR_ATTACHMENT_UNKNOWN" }
            : { effect: "applied", id: "55555555-5555-4555-8555-555555555555", url: assetUrl },
        },
      });
    }
    throw new Error(`Unexpected fixture transport: ${args.slice(0, 2).join(" ")}`);
  };
  const operations: LinearOperationBackend = {
    capabilities: async () => [
      {
        name: "delete_comment",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        annotations: {},
      },
    ],
    invoke: async (workspace, operation, input) => {
      assert.equal(workspace, "example");
      let data: unknown;
      if (operation === "get_document") {
        const document = documents[String(input.id)];
        assert(document, "Unexpected artifact document");
        data = { document: { ...document } };
      } else if (operation === "save_document") {
        const document = documents[String(input.id)];
        assert(document && typeof input.title === "string");
        document.title = input.title;
        state.renames.push({ ...input });
        data = { document: { ...document } };
      } else if (operation === "get_issue") {
        assert(["ENG-12", issueUuid].includes(String(input.id)));
        data = {
          issue: {
            id: "ENG-12",
            uuid: issueUuid,
            title: "Fixture issue",
            url: "https://linear.app/example/issue/ENG-12/fixture",
            attachments: attachments.map((item) => ({ ...item })),
          },
        };
      } else if (operation === "save_issue") {
        assert.equal(input.id, "ENG-12");
        assert(Array.isArray(input.links));
        state.links.push(...input.links);
        for (const item of input.links)
          attachments.push({
            id: "44444444-4444-4444-8444-444444444444",
            ...(item as { title: string; url: string }),
          });
        data = { id: "ENG-12" };
      } else if (operation === "delete_comment") {
        const id = String(input.id);
        assert(["allowed", "unknown"].includes(id), "A refused deletion reached the backend");
        state.deletions.push(id);
        if (id === "unknown")
          return { workspace, operation, effect: "unknown", error: "LINEAR_DELIVERY_UNKNOWN" };
        data = { id };
      } else throw new Error(`Unexpected fixture operation: ${operation}`);
      return { workspace, operation, effect: "applied", data };
    },
  };
  const uploader = createAxiUploader(run);
  const text = createLinearTextResolver(createLinearTextBackend(run));
  const artifactsBackend = createLinearArtifactBackend(operations, { upload: uploader });
  const artifacts = createLinearArtifactHandlers(artifactsBackend);
  const handlers = createLinearOperationHandlers(
    operations,
    connectLinearPermissionGate(pi, () => true),
  );
  const resources = createStandaloneResources({
    resolvers: [createLinearArtifactResolver(artifactsBackend), text, handlers.fields.resolver],
    write: [artifacts.write, handlers.write],
    insert: [artifacts.insert, handlers.insert],
    fileOperations: [artifacts.fileOperations, handlers.fileOperations],
    guides: await loadLinearGuides(),
  });
  pi.registerTool(createLinearUploadTool(uploader));
  pi.on("session_start", () => registerStandaloneTools(pi, resources));
  pi.on("agent_settled", async (_event, context) => {
    await writeFile(
      path.join(context.cwd, "standalone-actions-state.json"),
      JSON.stringify(state, null, 2),
    );
  });
}
