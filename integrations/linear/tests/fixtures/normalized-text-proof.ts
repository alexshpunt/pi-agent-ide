import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { encode } from "@toon-format/toon-v4";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL } from "pi-agent-ide/api/read";
import { connectTextEditorPlugin, TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "pi-agent-ide/api/text-editor";
import { createLinearTextBackend } from "#linear/text-backend.ts";
import { createLinearTextResolver } from "#linear/text-resource.ts";
import { connectLinearCreationReceipts, createLinearTextCreationHandler } from "#linear/text-create.ts";
import { registerLinearFailureRenderers } from "#linear/text-failure-renderer.ts";

const id = "71000000-0000-4000-8000-000000000006";
const issue = { id: "ENG-12", uuid: id, title: "Fixture issue",
  description: "", url: "https://linear.app/example/issue/ENG-12/title" };
const diff = { id: "55e4fd09-d7ed-4356-a456-5d965a8cc7ba",
  url: "https://github.com/example/repo/pull/162",
  appUrl: "https://linear.app/example/review/pr-258abca357fd",
  fullIdentifier: "example/repo#162" };
export default async function proof(pi: ExtensionAPI) {
  connectLinearCreationReceipts(pi);
  pi.on("session_start", (_event, context) => {
    context.ui.setToolsExpanded(process.env.LINEAR_CONFIRMED_EXPANDED === "1");
  });
  let unreadable = 0;
  const backend = createLinearTextBackend(async (cwd, args) => {
    const file = path.join(cwd, "linear-saved.md");
    if (args[0] === "issues") return encode({ issue });
    if (args[0] === "resources") return encode({ invocation: {
      workspace: "example", operation: "get_diff", effect: "applied",
      data: JSON.stringify(diff),
    } });
    if (args[1] === "update" || args[1] === "create") {
      const wanted = await readFile(args.at(-1)!, "utf8");
      const saved = wanted === "simulate-loss" ? "Server content"
        : wanted === "simulate-readback" ? "Saved despite unavailable readback" : wanted
        .replace(/^- \[x\]/gmu, "* [X]")
        .replace("[Evidence](https://example.org/proof)", "[Evidence](<https://example.org/proof>)")
        .replace("ENG-12", `<issue id="${id}" href="${issue.url}">ENG-12</issue>`)
        .replace(`[PR #162](${diff.url})`,
          `<pull-request id="${diff.id}" href="${diff.appUrl}">${diff.fullIdentifier}</pull-request>`);
      await writeFile(file, saved, "utf8");
      await appendFile(path.join(cwd, "linear-writes.log"), args[1] + "\n");
      if (wanted === "simulate-readback") unreadable = 2;
      return encode({ document: { id, url: "https://linear.app/example/document/workpad-1234abcd5678" } });
    }
    if (unreadable > 0) {
      unreadable--;
      throw new Error("private transport output");
    }
    return encode({ document: { id, title: "Workpad",
      url: "https://linear.app/example/document/workpad-1234abcd5678",
      content: await readFile(file, "utf8") } });
  });
  const resolver = createLinearTextResolver(backend);
  await Promise.all([
    connectReadPlugin(pi, {
      protocol: READ_PROTOCOL, apiVersion: READ_API_VERSION, id: resolver.id,
      setup(api) { api.addResolver({ resolver, priority: -100 }); },
    }),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL, apiVersion: TEXT_EDITOR_API_VERSION, id: resolver.id,
      setup(api) {
        api.addResolver({ resolver, priority: -100 });
        api.tool("write").addSemanticHandler(createLinearTextCreationHandler(backend.create));
        let installed = false;
        pi.on("agent_start", () => {
          if (installed) return;
          registerLinearFailureRenderers(api);
          installed = true;
        });
      },
    }),
  ]);
}
