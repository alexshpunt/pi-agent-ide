import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { resolveToolConfigPaths } from "pi-agent-ide/api/tool-config";
import { connectSearchPlugin, SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-ide/api/search";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Exercises only the installed public API, including reload and external registration. */
export default async function registerReleaseProbe(pi: ExtensionAPI): Promise<void> {
  await connectSearchPlugin(pi, {
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "release-probe",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "release-probe",
          tryResolve(request) {
            return request.query === "external:package"
              ? { kind: "resolved", payload: "external package connected" }
              : { kind: "not-handled" };
          },
          format(payload) {
            return { content: [{ type: "text", text: String(payload) }], details: {} };
          },
        },
      });
    },
  });
  pi.registerTool({
    name: "package_config_probe",
    label: "Package config probe",
    description: "Verify shipped config files.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _onUpdate, ctx) {
      const paths = ["formatters", "linters", "lsp-servers"].map(
        (name) =>
          resolveToolConfigPaths(ctx.cwd, name as "formatters" | "linters" | "lsp-servers").builtIn,
      );
      const configs = await Promise.all(
        paths.map(async (file) => JSON.parse(await readFile(file, "utf8")) as unknown),
      );
      return { content: [{ type: "text", text: JSON.stringify({ paths, configs }) }], details: {} };
    },
  });
  pi.registerTool({
    name: "tool_catalog_probe",
    label: "Tool catalog probe",
    description: "Capture tool definitions for parity checks.",
    parameters: Type.Object({}),
    async execute() {
      const tools = pi.getAllTools().map(({ name, description, parameters, promptGuidelines }) => ({
        name,
        description,
        parameters,
        promptGuidelines,
      }));
      return { content: [{ type: "text", text: "Tool definitions captured" }], details: { tools } };
    },
  });
  pi.registerCommand("package-reload", {
    description: "Reload the package under test.",
    async handler(_args, ctx) {
      await ctx.reload();
    },
  });
  pi.on("resources_discover", (event) => {
    if (event.reason === "reload")
      pi.sendUserMessage("Verify the reloaded package", { deliverAs: "followUp" });
  });
}
