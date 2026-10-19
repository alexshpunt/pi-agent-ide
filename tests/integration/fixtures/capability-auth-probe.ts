import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { denyOAuthRefresh, withoutOAuthRefresh } from "#capabilities/auth-guard.ts";

/** Exercise the real public registry's refresh gate without resolving or reading credentials. */
export default function capabilityAuthProbe(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "capability_auth_probe",
    label: "Auth guard probe",
    description: "Check that the public provider registry preserves a no-refresh gate without calling inference.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _onUpdate, context) {
      const original = context.modelRegistry.getProvider("anthropic");
      if (!original?.auth.oauth) throw new Error("The builtin Anthropic OAuth provider is required");
      context.modelRegistry.registerProvider(withoutOAuthRefresh(original));
      const guarded = context.modelRegistry.getProvider("anthropic");
      const installed = guarded?.auth.oauth?.refresh === denyOAuthRefresh;
      let refused = false;
      try {
        await guarded?.auth.oauth?.refresh(
          { type: "oauth", access: "SYNTHETIC", refresh: "SYNTHETIC", expires: 1 },
          new AbortController().signal,
        );
      } catch {
        refused = true;
      }
      const result = { installed, refused, originalUnchanged: original.auth.oauth.refresh !== denyOAuthRefresh };
      await writeFile(path.join(context.cwd, "guard-result.json"), JSON.stringify(result));
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
