import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { isExecutableAvailable, probeExecutable } from "pi-agent-doctor/api/executable";
import {
  DOCTOR_API_VERSION,
  DOCTOR_PROTOCOL,
  type DoctorPlugin,
} from "pi-agent-doctor/api/plugin-protocol";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";
import type { ReadTextState } from "pi-agent-read/api/tools/read";
import { createTextDocument } from "pi-agent-text";

import { executeJq, parseJqView } from "#src/jq.js";

export default async function registerFilesystemJq(pi: ExtensionAPI): Promise<void> {
  connectAgentDocumentation(pi, [
    await loadPackagedAgentGuide({
      id: "json-reading",
      description: "Query and transform JSON resources with jq read views",
      triggers: [{ tool: "read", viewPrefixes: ["jq:"] }],
    }),
  ]);
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
    api.addHandler({
      stage: "read",
      when: { resolvedBy: "filesystem", contentKind: "text" },
      async handler(context) {
        const state = context.state;
        if (state?.contentKind !== "text") return { kind: "continue", context };
        let selected: ReturnType<typeof parseJqView>;
        try {
          selected = parseJqView(context.request.views);
        } catch (error) {
          return jqFailure(state, error instanceof Error ? error.message : String(error));
        }
        if (selected === undefined) return { kind: "continue", context };
        let output: string;
        try {
          output = await executeJq(selected.filter, state.content[0].text, {
            cwd: context.resolverContext.cwd,
            ...(context.resolverContext.signal === undefined
              ? {}
              : { signal: context.resolverContext.signal }),
          });
        } catch (error) {
          return jqFailure(state, error instanceof Error ? error.message : String(error));
        }
        const transformed: ReadTextState = {
          ...state,
          content: [{ type: "text", text: output }],
          text: createTextDocument(state.source, output),
          preserveTruncatedOutput: true,
        };
        return { kind: "continue", context: { ...context, state: transformed } };
      },
    });
    api.describe(
      'JSON files accept views such as ["jq:.scripts | keys"] to query them with the installed jq executable.',
    );
  },
} satisfies ReadPlugin;

function jqFailure(state: ReadTextState, message: string) {
  return {
    kind: "return" as const,
    result: {
      content: [{ type: "text" as const, text: `jq failed: ${message}` }],
      details: {
        source: state.source,
        resolvedBy: state.resolvedBy,
        failure: {
          code: "READ_FAILED" as const,
          source: state.source,
          resolverId: state.resolvedBy,
          pluginId: "filesystem-jq",
          stage: "read" as const,
          message,
        },
      },
      isError: true,
    },
  };
}
const doctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "filesystem-jq",
  setup(api) {
    api.addSetupCheck({
      id: "jq",
      async inspect(context) {
        return (await isExecutableAvailable("jq", context.cwd, context.env))
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
        const result = await probeExecutable("jq", ["--version"], context.cwd, context.env);
        return [
          result.ok
            ? { status: "pass", message: "jq is available", detail: result.detail }
            : { status: "fail", message: "jq is not available", detail: result.detail },
        ];
      },
    });
  },
} satisfies DoctorPlugin;
