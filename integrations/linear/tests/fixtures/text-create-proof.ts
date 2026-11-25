import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL } from "pi-agent-ide/api/read";
import {
  connectTextEditorPlugin,
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-ide/api/text-editor";
import {
  connectLinearCreationReceipts,
  createLinearTextCreationHandler,
} from "#linear/text-create.ts";
import { connectResultTargets, type ResourceResolver } from "pi-agent-ide/api/resource";
import { createLinearBodySelectionHandler } from "#linear/text-selection.ts";
import { linearBodyProvenance } from "#linear/text-provenance.ts";
import {
  connectSearchPlugin,
  SEARCH_API_VERSION,
  SEARCH_PROTOCOL,
} from "pi-agent-ide/api/search";
import { createLinearSearchResolver } from "#linear/search.ts";
import { createLinearEnvironmentProvider } from "#linear/environment.ts";
import { textFromRead } from "#linear/resource-read.ts";
import type { ReadPluginApi } from "pi-agent-ide/api/read";
import { firstMatchTarget, readFirstLineAnchor } from "./read-anchor.ts";

const createSource = "linear://example/issue/ENG-12/documents/new?title=Workpad";
const bodySource = "linear://example/document/71000000-0000-4000-8000-000000000006/content";
const url = "https://linear.app/example/document/workpad-1234abcd5678";

export default async function proof(pi: ExtensionAPI): Promise<void> {
  connectLinearCreationReceipts(pi);
  pi.registerTool({
    name: "verify_editor_scope",
    label: "Verify editor scope",
    description: "Test-only probe edits exactly the real Read result selection.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, context) {
      const selected = await context.executeTool(
        "read",
        { path: bodySource, offset: 1, limit: 1, views: ["anchors"] },
        { signal },
      );
      if (selected.isError) throw new Error("Read failed");
      const reference = selected.result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const expanded = await context.executeTool(
        "read",
        { path: reference, limit: 100 },
        { signal },
      );
      if (expanded.isError) throw new Error("Selected Read failed");
      const expandedReference = expanded.result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const outside = await context.executeTool(
        "search",
        { path: expandedReference, query: "Last line" },
        { signal },
      );
      const search = outside.result.details as {
        payload?: { mode?: string; matches?: unknown[]; complete?: boolean };
      };
      const scope = search.payload;
      if (outside.isError || scope?.mode !== "text" || scope.matches?.length !== 0 || scope.complete !== true) {
        throw new Error("Read widened its selection");
      }
      const edited = await context.executeTool(
        "replace",
        { path: expandedReference, text: "Scoped\n" },
        { signal },
      );
      if (edited.isError) {
        const failure = edited.result.content.find((block) => block.type === "text");
        throw new Error(
          `Selected edit failed: ${failure?.type === "text" ? failure.text : "no reason"}`,
        );
      }
      if (
        (await readFile(path.join(context.cwd, "created-body.txt"), "utf8")) !==
        "Scoped\nLast line\n"
      )
        throw new Error(
          `Expanded Read edit saved ${JSON.stringify(await readFile(path.join(context.cwd, "created-body.txt"), "utf8"))}`,
        );
      const { anchor } = await readFirstLineAnchor(readApi, bodySource, { cwd: context.cwd, signal });
      const anchorEdit = await context.executeTool(
        "replace",
        { path: bodySource, at: anchor, text: "Anchored" },
        { signal },
      );
      if (anchorEdit.isError) throw new Error("Anchor edit failed");
      const searched = await context.executeTool(
        "search",
        { path: bodySource, query: "Anchored" },
        { signal },
      );
      if (searched.isError) throw new Error("Body Search failed");
      const searchEdit = await context.executeTool(
        "replace",
        { path: firstMatchTarget(searched.result.details), text: "Searched" },
        { signal },
      );
      if (searchEdit.isError) throw new Error("Search selection edit failed");
      const stale = await context.executeTool(
        "read",
        { path: bodySource, offset: 1, limit: 1 },
        { signal },
      );
      if (stale.isError) throw new Error("Fresh Read failed");
      const staleReference = stale.result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      await writeFile(
        path.join(context.cwd, "created-body.txt"),
        "External change\nLast line\n",
        "utf8",
      );
      const rejected = await context.executeTool(
        "replace",
        { path: staleReference, text: "Wrong" },
        { signal },
      );
      if (!rejected.isError) throw new Error("Stale selection overwrote the source");
      return {
        content: [
          { type: "text", text: "Exact Read/Search ranges edited; stale source rejected." },
        ],
        details: { source: bodySource, staleRejected: true },
      };
    },
  });
  const resolver: ResourceResolver = {
    id: "linear-text-proof",
    async tryResolve(source, context) {
      if (source !== createSource && source !== bodySource) return { kind: "not-handled" };
      const file = path.join(context.cwd, "created-body.txt");
      const body = source === bodySource ? await readFile(file, "utf8") : "";
      return {
        kind: "resolved",
        resource:
          source === createSource
            ? { source, read: async () => [{ type: "text", text: "" }] }
            : {
                source,
                link: url,
                sourceBytes: Buffer.from(body, "utf8"),
                read: async () => [{ type: "text", text: body }],
                write: async (blocks) => {
                  if (blocks.length !== 1 || blocks[0].type !== "text")
                    throw new Error("Text required");
                  await writeFile(file, blocks[0].text, "utf8");
                },
              },
      };
    },
  };
  let readApi: ReadPluginApi | undefined;
  const readText = textFromRead(() => readApi);
  await Promise.all([
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "linear-text-proof",
      setup(api) {
        api.addEnvironmentProvider(createLinearEnvironmentProvider(readText));
        api.addResolver({
          priority: -200,
          resolver: createLinearSearchResolver(
            async () => {
              throw new Error("Native lookup is not part of this fixture");
            },
            readText,
            (selection, context) => api.registerSelection(selection, context),
          ),
        });
      },
    }),
    connectReadPlugin(pi, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: "linear-text-proof",
      setup(api) {
        readApi = api;
        api.addResolver({ resolver, priority: -100 });
        api.addHandler({
          stage: "read",
          when: { resolvedBy: resolver.id, contentKind: "text" },
          handler: linearBodyProvenance,
        });
        api.addHandler({
          stage: "post-read",
          handler: createLinearBodySelectionHandler(
            connectResultTargets(pi),
            api.read,
            resolver.id,
          ),
        });
      },
    }),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "linear-text-proof",
      setup(api) {
        api.addResolver({ resolver, priority: -100 });
        api.tool("write").addSemanticHandler(
          createLinearTextCreationHandler(async (_address, content, cwd) => {
            if (content === "simulate-unknown") throw new Error("private-fixture-token");
            await writeFile(path.join(cwd, "created-body.txt"), content, "utf8");
            return { id: "71000000-0000-4000-8000-000000000006", source: bodySource, url };
          }),
        );
      },
    }),
  ]);
}
