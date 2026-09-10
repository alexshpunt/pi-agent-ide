import path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import {
  createApplyResultRenderer,
  createApplyCallRenderer,
} from "pi-agent-text-editor/api/apply-renderer";
import type { AnyTextMutationToolRegistration } from "pi-agent-text-editor/api/mutation-tool";
import { MutationPanel } from "./src/mutation-panel.js";
import { resolveMutationResultResources } from "./src/mutation-result.js";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";

import { createMutationAnimationPressure } from "./src/animation-pressure.js";
import { registerMutationRenderers, renderWrittenMutationHeader } from "./src/renderer.js";

import { compactMutationDetails } from "./src/persisted-result.js";
import type { FileMutationBatchResult } from "pi-agent-text-editor/api/mutation-result";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerTextEditorRenderer(pi: ExtensionAPI): Promise<void> {
  const animationPressure = createMutationAnimationPressure(pi);
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "text-editor-renderer",
    setup(api) {
      const registrations = new Map<string, AnyTextMutationToolRegistration>();
      api.onMutationTool((registration) => registrations.set(registration.name, registration));
      api.addToolRenderer({
        tool: "diff",
        renderResult(result, options, theme, context) {
          const details = result.details as FileMutationBatchResult | undefined;
          if (context.isError || details?.results === undefined)
            return new Text(
              result.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n"),
              0,
              0,
            );
          const panel = new MutationPanel(theme);
          panel.setBackground("toolSuccessBg");
          panel.setExpanded(options.expanded);
          panel.setResourceLabelsVisible(true);
          panel.setResultResources(resolveMutationResultResources(details, undefined));
          return panel;
        },
      });
      api.addToolRenderer({
        tool: "apply",
        renderCall: createApplyCallRenderer((call, theme) => {
          const registration = registrations.get(call.name === "remove" ? "delete" : call.name);
          const display = (argument: typeof call.path) =>
            argument ? (argument.literal ? argument.text : `‹${argument.text}›`) : "…";
          const source = display(
            call.arguments[registration?.source.field ?? "path"] ?? call.arguments.file,
          );
          const identityKeys =
            call.name === "diff"
              ? ["before", "after"]
              : call.name === "search"
                ? ["path", "query"]
                : [registration?.source.field ?? (call.arguments.file ? "file" : "path"), "target"];
          const parameters = Object.entries(call.arguments)
            .filter(([key]) => !identityKeys.includes(key))
            .map(([key, value]) => `${key}: ${display(value)}`)
            .join(" · ");
          const suffix = parameters ? ` ${theme.fg("dim", parameters)}` : "";
          if (registration)
            return (
              renderWrittenMutationHeader(
                registration,
                {
                  [registration.source.field]: source,
                  ...(call.target ? { target: display(call.target) } : {}),
                },
                theme,
              ) + suffix
            );
          const identity =
            call.name === "search"
              ? `${display(call.query)}${call.path ? ` · ${source}` : ""}`
              : call.name === "diff"
                ? `${display(call.before)} → ${display(call.after)}`
                : `${source}${call.target ? ` → ${display(call.target)}` : ""}`;
          return `${theme.fg("toolTitle", theme.bold(call.name))} ${theme.fg("accent", identity)}${suffix}`;
        }),
        renderResult: createApplyResultRenderer((details, theme, expanded, cwd) => {
          const panel = new MutationPanel(theme);
          panel.setBackground("toolSuccessBg");
          panel.setExpanded(expanded);
          panel.setResourceLabelsVisible(true);
          panel.setResultResources(
            resolveMutationResultResources(details, undefined).map((resource) => ({
              ...resource,
              path: path.isAbsolute(resource.path)
                ? path.relative(cwd, resource.path)
                : resource.path,
            })),
          );
          return panel;
        }),
      });
      const tools = new Set<string>();
      api.onMutationTool(({ name }) => tools.add(name));
      registerMutationRenderers(
        api,
        animationPressure,
        () => pi.getFlag("pi-agent-ide-no-animations") !== true,
      );
      pi.on("tool_result", (event) => {
        if (
          !tools.has(event.toolName) ||
          typeof event.details !== "object" ||
          event.details === null
        )
          return;
        const details = event.details as FileMutationBatchResult;
        if (!Array.isArray(details.results)) return;
        return { details: compactMutationDetails(details) };
      });
    },
  } satisfies TextEditorPlugin;

  await connectTextEditorPlugin(pi, plugin);
}
