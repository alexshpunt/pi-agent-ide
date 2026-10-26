import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { isExecutableAvailable, probeExecutable } from "pi-agent-doctor/api/executable";
import {
  DOCTOR_API_VERSION,
  DOCTOR_PROTOCOL,
  type DoctorPlugin,
} from "pi-agent-doctor/api/plugin-protocol";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";
import { createJqReadHandler } from "#src/api/jq.js";

export default async function registerFilesystemJq(pi: ExtensionAPI): Promise<void> {
  await Promise.all([connectReadPlugin(pi, readPlugin), connectDoctorPlugin(pi, doctorPlugin)]);
}

const readPlugin = {
  protocol: READ_PROTOCOL,
  apiVersion: READ_API_VERSION,
  id: "filesystem-jq",
  setup(api) {
    api.addView({
      view: "jq",
      presenter: { id: "filesystem-jq", present: (document) => document },
    });
    const jq = createJqReadHandler({
      pluginId: "filesystem-jq",
      input: (context) =>
        context.state?.contentKind === "text" ? context.state.content[0].text : undefined,
    });
    api.addHandler({
      stage: "read",
      when: { resolvedBy: "any", contentKind: "text" },
      handler(context) {
        const state = context.state;
        if (
          state?.contentKind !== "text" ||
          (state.resolvedBy !== "filesystem" && state.resolvedBy !== "ssh")
        )
          return { kind: "continue", context };
        return jq(context);
      },
    });
    api.describe({
      views:
        "jq:<filter> — run jq on a JSON file or a resource whose provider supplies JSON (JSONL record by record); use alone; offset and limit apply to its output.",
    });
  },
} satisfies ReadPlugin;

const doctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "filesystem-jq",
  setup(api) {
    api.addSetupCheck({
      id: "jq",
      async inspect(context) {
        return (await isExecutableAvailable(
          "jq",
          context.workspace ? process.cwd() : context.cwd,
          context.workspace ? process.env : context.env,
          context.signal,
        ))
          ? {}
          : {
              actions: [
                {
                  id: "jq-unavailable",
                  message: "JSON jq views are unavailable because jq was not found",
                },
              ],
            };
      },
    });
    api.addCheck({
      id: "jq",
      title: "JSON jq views",
      async run(context) {
        context.signal?.throwIfAborted();
        // jq transforms fetched bytes on the controller, including snapshots from an SSH owner.
        const result = await probeExecutable(
          "jq",
          ["--version"],
          context.workspace ? process.cwd() : context.cwd,
          context.workspace ? process.env : context.env,
          context.signal,
        );
        context.signal?.throwIfAborted();
        return [
          result.ok
            ? {
                status: "pass",
                message: "jq is available",
                detail: context.workspace
                  ? `Controller content adapter: ${result.detail}`
                  : result.detail,
              }
            : { status: "fail", message: "jq is not available", detail: result.detail },
        ];
      },
    });
  },
} satisfies DoctorPlugin;
