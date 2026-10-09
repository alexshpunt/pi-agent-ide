import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdePlugin } from "pi-agent-ide/api/plugin-protocol";

import { formatterDoctorPlugin } from "./src/doctor-plugin.js";
import { createFormatter, type FormatterRuntime } from "./src/formatter.js";
export { FormatterCommandRegistry } from "./src/registry.js";
export { FORMATTER_RECIPES } from "./src/catalog.js";
export type { FormatterRuntime } from "./src/formatter.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IdeTool } from "pi-agent-ide/api/toolchain";

export default async function registerFormatter(pi: ExtensionAPI): Promise<void> {
  await registerFormatterWithOwner(pi);
}

/** Register ordinary formatter hooks with optional owner project and execution callbacks. */
export async function registerFormatterWithOwner(
  pi: ExtensionAPI,
  runtime?: FormatterRuntime,
): Promise<void> {
  const selected = createFormatter(runtime);
  const formatter = {
    kind: "formatter",
    name: "pi-agent-ide-formatter",
    priority: 200,
    extensions: ["*"],
    detect: () => Promise.resolve(true),
    async format(input, context) {
      return selected.format(input, context);
    },
  } satisfies IdeTool;
  const plugin = {
    protocol: IDE_PROTOCOL,
    apiVersion: IDE_API_VERSION,
    id: "formatter",
    setup(api): void {
      api.addTool(formatter);
    },
  } satisfies IdePlugin;

  await Promise.all([connectIdePlugin(pi, plugin), connectDoctorPlugin(pi, formatterDoctorPlugin)]);
}
