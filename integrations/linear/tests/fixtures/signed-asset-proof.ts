import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { encode } from "@toon-format/toon-v4";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  connectReadPlugin,
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPluginApi,
} from "pi-agent-ide/api/read";
import { connectResultTargets } from "pi-agent-ide/api/resource";
import {
  connectTextEditorPlugin,
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-ide/api/text-editor";
import { connectSearchPlugin, SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-ide/api/search";
import { createLinearTextBackend } from "#linear/text-backend.ts";
import { createLinearTextResolver } from "#linear/text-resource.ts";
import { createLinearBodySelectionHandler } from "#linear/text-selection.ts";
import { linearBodyProvenance } from "#linear/text-provenance.ts";
import { createLinearSearchResolver } from "#linear/search.ts";
import { createLinearEnvironmentProvider } from "#linear/environment.ts";
import { textFromRead } from "#linear/resource-read.ts";
import { firstMatchTarget, readFirstLineAnchor } from "./read-anchor.ts";

const source = "linear://example/issue/ENG-12/description";
const asset = "https://uploads.linear.app/workspace/upload/file";

/** Use the real text backend with a CLI fixture that signs every body read differently. */
export default async function signedAssetProof(pi: ExtensionAPI): Promise<void> {
  let views = 0;
  let updates = 0;
  const backend = createLinearTextBackend(async (cwd, args) => {
    const file = path.join(cwd, "body.md");
    if (args[1] === "update") {
      updates++;
      await writeFile(file, await readFile(args.at(-1)!, "utf8"));
      return encode({ issue: { id: "ENG-12" } });
    }
    const description = (await readFile(file, "utf8")).replace(
      asset,
      `${asset}?signature=view-${++views}`,
    );
    return encode({
      issue: {
        id: "ENG-12",
        title: "Signed asset proof",
        url: "https://linear.app/example/issue/ENG-12/proof",
        description,
      },
    });
  });
  const resolver = createLinearTextResolver(backend);
  let readApi: ReadPluginApi | undefined;
  const readText = textFromRead(() => readApi);
  await Promise.all([
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "signed-asset-proof",
      setup(api) {
        api.addEnvironmentProvider(createLinearEnvironmentProvider(readText));
        api.addResolver({
          priority: -200,
          resolver: createLinearSearchResolver(
            async () => {
              throw new Error("Native search is not part of this fixture");
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
      id: "signed-asset-proof",
      setup(api) {
        api.addResolver({ resolver, priority: -100 });
        readApi = api;
        api.addHandler({
          stage: "read",
          when: { resolvedBy: resolver.id, contentKind: "text" },
          handler: linearBodyProvenance,
        });
        api.addHandler({
          stage: "post-read",
          handler: createLinearBodySelectionHandler(connectResultTargets(pi), api.read, resolver.id),
        });
      },
    }),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "signed-asset-proof",
      setup(api) {
        api.addResolver({ resolver, priority: -100 });
      },
    }),
  ]);
  pi.registerTool({
    name: "verify_signed_asset_edits",
    label: "Verify signed asset edits",
    description: "Test-only probe exercises stable anchors, result selections and real conflicts.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, context) {
      const file = path.join(context.cwd, "body.md");
      await writeFile(file, `Before [file](<${asset}>) remains.\nLast line\n`);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await context.executeTool(name, args, { signal });
        const text = result.result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        if (result.isError) throw new Error(`${name} failed: ${text}`);
        return text;
      };
      const { text: first, anchor } = await readFirstLineAnchor(readApi, source, { cwd: context.cwd, signal });
      if (first.includes("?signature=")) throw new Error("Read exposed a changing signature");
      await call("replace", {
        path: source,
        at: anchor,
        text: `Changed [file](<${asset}>) remains.`,
      });
      if ((await readFile(file, "utf8")) !== `Changed [file](<${asset}>) remains.\nLast line\n`)
        throw new Error("Anchor edit changed other content");
      const read = await call("read", { path: source, offset: 1, limit: 1 });
      const search = await context.executeTool("search", { path: read, query: "Changed" }, { signal });
      if (search.isError) throw new Error("Scoped Search failed");
      await call("replace", { path: firstMatchTarget(search.result.details), text: "Scoped" });
      if ((await readFile(file, "utf8")) !== `Scoped [file](<${asset}>) remains.\nLast line\n`)
        throw new Error("Selected edit changed other content");
      const stale = await call("read", { path: source });
      await writeFile(file, `External [file](<${asset}>) remains.\nLast line\n`);
      const rejected = await context.executeTool(
        "replace",
        { path: stale, text: "Wrong" },
        { signal },
      );
      if (!rejected.isError || updates !== 2) throw new Error("Real conflict was not rejected");
      const { anchor: freshAnchor } = await readFirstLineAnchor(readApi, source, { cwd: context.cwd, signal });
      await call("replace", { path: source, at: freshAnchor, text: "External" });
      if ((await readFile(file, "utf8")) !== "External\nLast line\n")
        throw new Error("Link removal changed other content");
      return {
        content: [{
          type: "text",
          text: "Stable anchors and Read/Search edits passed; real conflicts rejected; link removed without other changes.",
        }],
        details: { views, updates, source },
      };
    },
  });
}
