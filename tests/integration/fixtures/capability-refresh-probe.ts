import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { applyAuthenticationPolicy } from "#capabilities/auth-guard.ts";

/** Exercise real public registry credential persistence using synthetic OAuth, never inference. */
export default function capabilityRefreshProbe(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "capability_refresh_probe",
    label: "Dedicated refresh probe",
    description: "Check dedicated private OAuth persistence without network or inference.",
    parameters: Type.Object({ delegated: Type.Optional(Type.Boolean()) }),
    async execute(_id, args, _signal, _onUpdate, context) {
      const authPath = path.join(context.cwd, "synthetic-auth.json");
      const audit = path.join(context.cwd, "synthetic-auth-secrets.jsonl");
      const initial = { type: "oauth", access: "SYNTHETIC_EXPIRED_ACCESS", refresh: "SYNTHETIC_EXPIRED_REFRESH", expires: Date.now() + 3_600_000 };
      const next = { type: "oauth" as const, access: "SYNTHETIC_ROTATED_ACCESS", refresh: "SYNTHETIC_ROTATED_REFRESH", expires: Date.now() + 3_600_000 };
      await writeFile(authPath, JSON.stringify({ fixture: initial }), { mode: 0o600 });
      await writeFile(audit, "", { mode: 0o600 });
      let refreshCalls = 0;
      let inferenceCalls = 0;
      const provider: Provider = {
        id: "fixture",
        name: "Synthetic refresh fixture",
        getModels: () => [],
        stream: () => { inferenceCalls++; throw new Error("Inference is forbidden"); },
        streamSimple: () => { inferenceCalls++; throw new Error("Inference is forbidden"); },
        auth: {
          oauth: {
            name: "Synthetic OAuth",
            login: async () => { throw new Error("Login is forbidden"); },
            refresh: async (credential) => {
              if (credential.refresh !== initial.refresh) throw new Error("Wrong synthetic refresh input");
              refreshCalls++;
              return next;
            },
            toAuth: async (credential) => ({ apiKey: credential.access }),
          },
        },
      };
      const runtime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      const registry = new ModelRegistry(runtime);
      registry.registerProvider(provider);
      if (!context.model) throw new Error("Missing fixture model context");
      const modelProvider = args.delegated ? "connector-fixture" : "fixture";
      applyAuthenticationPolicy(
        { model: { provider: modelProvider }, modelRegistry: registry },
        { provider: "fixture", modelProvider, expiresAt: 1, refreshAllowed: true },
        audit,
      );
      await writeFile(authPath, JSON.stringify({ fixture: { ...initial, expires: 1 } }));
      const auth = await registry.getProviderAuth("fixture");
      const persisted = JSON.parse(await readFile(authPath, "utf8"));
      const recorded = (await readFile(audit, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const result = {
        refreshCalls,
        inferenceCalls,
        noCredentialRekey: Object.keys(persisted).join(",") === "fixture",
        authenticated: auth?.auth.apiKey === next.access,
        persisted: persisted.fixture?.access === next.access && persisted.fixture?.refresh === next.refresh,
        audited: recorded.some((credential) => credential.access === next.access && credential.refresh === next.refresh),
        originalProviderUnchanged: provider.auth.oauth?.refresh !== registry.getProvider("fixture")?.auth.oauth?.refresh,
      };
      await writeFile(path.join(context.cwd, "refresh-result.json"), JSON.stringify(result));
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
