import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdePlugin } from "pi-agent-ide/api/plugin-protocol";

import { formatterDoctorPlugin } from "./src/doctor-plugin.js";
import { createFormatter } from "./src/formatter.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IdeTool } from "pi-agent-ide/api/toolchain";

export default async function registerFormatter(pi: ExtensionAPI): Promise<void> {
  const formatter = {
    kind: "formatter",
    name: "pi-agent-ide-formatter",
    priority: 200,
    extensions: ["*"],
    detect: () => Promise.resolve(true),
    async format(input, context) {
      return createFormatter().format(input, context);
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
