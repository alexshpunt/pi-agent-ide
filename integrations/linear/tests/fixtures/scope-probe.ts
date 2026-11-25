import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  connectReadPlugin,
  READ_PROTOCOL,
  READ_API_VERSION,
  type ReadPluginApi,
} from "pi-agent-ide/api/read";
import {
  connectSearchPlugin,
  SEARCH_PROTOCOL,
  SEARCH_API_VERSION,
  type SearchPluginApi,
} from "pi-agent-ide/api/search";

/** Test-only probe drives public protocol calls using actual issued result targets, not fabricated IDs. */
export default async function probe(pi: ExtensionAPI) {
  let read: ReadPluginApi | undefined;
  let search: SearchPluginApi | undefined;
  let target: string | undefined;
  pi.on("tool_result", (event) => {
    if (
      event.toolName === "search" &&
      event.input.query === "Full document" &&
      String(event.input.path).startsWith("linear://")
    ) {
      const payload = (event.details as { payload?: { selection?: { target?: string } } })?.payload;
      target = payload?.selection?.target;
    }
  });
  pi.registerTool({
    name: "verify_scope",
    label: "Verify scope",
    description: "Verify a real Linear source selection in this test workspace.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, context) {
      if (!target || !read || !search) throw new Error("Missing real selection or protocol");
      const selected = await read.read({ path: target }, { cwd: context.cwd, signal }, "script");
      if (
        selected.isError ||
        !JSON.stringify(selected.script).includes("Full document") ||
        JSON.stringify(selected.script).includes("Last line")
      )
        throw new Error("Read widened or failed the range");
      const outside = await search.search(
        { query: "Last", path: target },
        { cwd: context.cwd, signal },
        "script",
      );
      const data = outside.script?.data as { matches?: unknown[] };
      if (outside.isError || data?.matches?.length !== 0)
        throw new Error("Search widened or failed the range");
      await writeFile(path.join(context.cwd, ".pi/fixture-changed"), "changed");
      const stale = await search.search(
        { query: "Full", path: target },
        { cwd: context.cwd, signal },
        "script",
      );
      if (!stale.isError) throw new Error("Changed snapshot was accepted");
      return {
        content: [
          { type: "text", text: "Exact Read/Search ranges verified; stale source rejected." },
        ],
        details: {},
      };
    },
  });
  await Promise.all([
    connectReadPlugin(pi, {
      id: "scope-probe",
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      setup(api) {
        read = api;
      },
    }),
    connectSearchPlugin(pi, {
      id: "scope-probe",
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      setup(api) {
        search = api;
      },
    }),
  ]);
}
