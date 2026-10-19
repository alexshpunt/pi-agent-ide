import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { stageDedicatedClaudeFileAuthentication } from "#capabilities/auth.ts";
import { applyAuthenticationPolicy } from "#capabilities/auth-guard.ts";

/** Exercise file-derived OAuth in the real public registry, without network or inference. */
export default function claudeFileProbe(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "capability_claude_file_probe",
    label: "Claude file-auth probe",
    description: "Verify isolated synthetic Claude credential rotations through the public registry.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _onUpdate, context) {
      const dedicated = path.join(context.cwd, "dedicated");
      const state = path.join(context.cwd, "state");
      await mkdir(dedicated, { mode: 0o700 });
      const file = path.join(dedicated, ".credentials.json");
      const authFile = path.join(state, "agent/auth.json");
      const initial = { accessToken: "SYNTHETIC_FILE_INITIAL_ACCESS", refreshToken: "SYNTHETIC_FILE_INITIAL_REFRESH", expiresAt: Date.now() + 3_600_000 };
      const middle = { accessToken: "SYNTHETIC_FILE_MIDDLE_ACCESS", refreshToken: "SYNTHETIC_FILE_MIDDLE_REFRESH", expiresAt: Date.now() + 3_600_000 };
      const next = { accessToken: "SYNTHETIC_FILE_FINAL_ACCESS", refreshToken: "SYNTHETIC_FILE_FINAL_REFRESH", expiresAt: Date.now() + 3_600_000 };
      const credential = (value: typeof initial) => ({ type: "oauth" as const, access: value.accessToken, refresh: value.refreshToken, expires: value.expiresAt });
      await writeFile(file, JSON.stringify({ claudeAiOauth: initial }), { mode: 0o600 });
      const staged = await stageDedicatedClaudeFileAuthentication(state, "anthropic", dedicated);
      try {
        await writeFile(authFile, JSON.stringify({ anthropic: credential(initial) }));
        let refreshCalls = 0;
        let inferenceCalls = 0;
        let authCalls = 0;
        const provider: Provider = {
          id: "anthropic", name: "Synthetic file auth", getModels: () => [],
          stream: () => { inferenceCalls++; throw new Error("Inference forbidden"); },
          streamSimple: () => { inferenceCalls++; throw new Error("Inference forbidden"); },
          auth: { oauth: {
            name: "Synthetic file auth",
            login: async () => { throw new Error("Login forbidden"); },
            refresh: async () => {
              refreshCalls++;
              await writeFile(file, JSON.stringify({ claudeAiOauth: next }));
              await writeFile(authFile, JSON.stringify({ anthropic: credential(next) }));
              return credential(next);
            },
            toAuth: async (current) => {
              authCalls++;
              if (authCalls === 1) {
                await writeFile(file, JSON.stringify({ claudeAiOauth: middle }));
                await writeFile(authFile, JSON.stringify({ anthropic: credential(middle) }));
                return { apiKey: middle.accessToken };
              }
              return { apiKey: current.access };
            },
          } },
        };
        const runtime = await ModelRuntime.create({ authPath: authFile, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
        const registry = new ModelRegistry(runtime);
        registry.registerProvider(provider);
        applyAuthenticationPolicy(
          { model: { provider: "anthropic" }, modelRegistry: registry },
          { ...staged.policy, claudeCredentialFile: file },
          path.join(state, "auth-secrets.jsonl"),
        );
        const first = await registry.getProviderAuth("anthropic");
        await writeFile(authFile, JSON.stringify({ anthropic: { ...credential(middle), expires: 1 } }));
        const second = await registry.getProviderAuth("anthropic");
        await staged.refreshSecrets?.();
        const persisted = JSON.parse(await readFile(file, "utf8"));
        const seeded = JSON.parse(await readFile(authFile, "utf8"));
        const result = {
          refreshCalls, inferenceCalls,
          firstAuthenticated: first?.auth.apiKey === middle.accessToken,
          secondAuthenticated: second?.auth.apiKey === next.accessToken,
          privateFilePersisted: persisted.claudeAiOauth?.refreshToken === next.refreshToken,
          seededPiPersisted: seeded.anthropic?.access === next.accessToken,
          allRotationsRedacted: [initial, middle, next].every((value) => [value.accessToken, value.refreshToken].every((secret) => staged.redact(secret) === "[REDACTED_AUTH_TOKEN]")),
          originalProviderUnchanged: provider.auth.oauth?.refresh !== registry.getProvider("anthropic")?.auth.oauth?.refresh,
        };
        await writeFile(path.join(context.cwd, "claude-file-result.json"), JSON.stringify(result));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } finally { await staged.release?.(); }
    },
  });
}
