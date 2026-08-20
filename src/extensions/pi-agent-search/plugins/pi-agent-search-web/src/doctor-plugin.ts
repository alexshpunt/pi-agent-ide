import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";

import { loadWebsearchConfig } from "./config.js";

import type { DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

/**
Search credential and routing checks owned by the web-search plugin.
*/
export const webSearchDoctorPlugin: DoctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "search.web",
  setup(api): void {
    api.addCheck({
      id: "providers",
      title: "Web search",
      async run(context) {
        const loaded = await loadWebsearchConfig({ cwd: context.cwd, env: context.env });

        if (!loaded.ok) {
          return [{ status: "fail", message: loaded.message, detail: loaded.source }];
        }

        return loaded.config.providers.map((provider) => {
          const isFree = provider.provider === "duckduckgo-html";
          const isReady =
            isFree || (typeof provider.apiKey === "string" && provider.apiKey.length > 0);
          return {
            status: isReady ? ("pass" as const) : ("warn" as const),
            message: isReady
              ? `${provider.id ?? provider.provider}: credentials available`
              : `${provider.id ?? provider.provider}: credentials missing`,
            detail: loaded.source,
          };
        });
      },
    });
  },
};
