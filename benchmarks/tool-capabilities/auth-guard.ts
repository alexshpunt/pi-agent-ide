import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertAuthLifetime, type AuthPolicy } from "./auth.ts";

/** No refresh callback may reach a network transport, even after an unexpected auth failure. */
export function denyOAuthRefresh(): never {
  throw new Error("OAuth refresh is forbidden for this capability run");
}

/** Preserve provider transport and token derivation, replacing only its refresh operation. */
export function withoutOAuthRefresh(provider: Provider): Provider {
  return provider.auth.oauth
    ? {
        ...provider,
        auth: { ...provider.auth, oauth: { ...provider.auth.oauth, refresh: denyOAuthRefresh } },
      }
    : provider;
}

type OAuthRefresh = NonNullable<Provider["auth"]["oauth"]>["refresh"];
const observedRefreshes = new WeakSet<OAuthRefresh>();

/** Retain rotated secrets only in disposable private state, before any output is exported. */
export function observeOAuthRefresh(provider: Provider, audit: string): Provider {
  const oauth = provider.auth.oauth;
  if (!oauth || observedRefreshes.has(oauth.refresh)) return provider;
  const refresh: typeof oauth.refresh = async (credential, signal) => {
    const next = await oauth.refresh(credential, signal);
    appendFileSync(audit, JSON.stringify(next) + "\n", { mode: 0o600 });
    return next;
  };
  observedRefreshes.add(refresh);
  return { ...provider, auth: { ...provider.auth, oauth: { ...oauth, refresh } } };
}
const observedClaudeProviders = new WeakMap<Provider, Provider>();

/** Record file-derived credentials after each public auth boundary, including failed refreshes. */
export function observeClaudeFileAuthentication(
  provider: Provider,
  audit: string,
  credentialFile: string,
): Provider {
  const previous = observedClaudeProviders.get(provider);
  if (previous) return previous;
  const oauth = provider.auth.oauth;
  if (!oauth) throw new Error("Claude-file connector did not register OAuth");
  const remember = () => {
    const parsed: unknown = JSON.parse(readFileSync(credentialFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || !("claudeAiOauth" in parsed))
      throw new Error("Claude-file authentication cannot be audited");
    const value = parsed.claudeAiOauth;
    if (
      !value ||
      typeof value !== "object" ||
      !("accessToken" in value) ||
      !("refreshToken" in value) ||
      typeof value.accessToken !== "string" ||
      typeof value.refreshToken !== "string"
    )
      throw new Error("Claude-file authentication cannot be audited");
    appendFileSync(
      audit,
      JSON.stringify({ type: "oauth", access: value.accessToken, refresh: value.refreshToken }) +
        "\n",
      { mode: 0o600 },
    );
    const seeded: unknown = JSON.parse(
      readFileSync(path.join(path.dirname(audit), "agent/auth.json"), "utf8"),
    );
    if (!seeded || typeof seeded !== "object")
      throw new Error("Seeded Pi authentication cannot be audited");
    const seededCredentials: unknown[] = Object.values(seeded);
    for (const credential of seededCredentials) {
      if (
        !credential ||
        typeof credential !== "object" ||
        !("type" in credential) ||
        credential.type !== "oauth" ||
        !("access" in credential) ||
        typeof credential.access !== "string" ||
        !("refresh" in credential) ||
        typeof credential.refresh !== "string"
      )
        throw new Error("Seeded Pi authentication cannot be audited");
      appendFileSync(audit, JSON.stringify(credential) + "\n", { mode: 0o600 });
    }
  };
  remember();
  const wrapped: Provider = {
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...oauth,
        refresh: async (credential, signal) => {
          try {
            const next = await oauth.refresh(credential, signal);
            appendFileSync(audit, JSON.stringify(next) + "\n", { mode: 0o600 });
            return next;
          } finally {
            remember();
          }
        },
        toAuth: async (credential) => {
          try {
            return await oauth.toAuth(credential);
          } finally {
            remember();
          }
        },
      },
    },
  };
  observedClaudeProviders.set(provider, wrapped);
  observedClaudeProviders.set(wrapped, wrapped);
  return wrapped;
}
/** Enforce the selected private-auth mode through Pi's public provider registry. */
export function applyAuthenticationPolicy(
  context: {
    model?: { provider: string };
    modelRegistry: {
      getProvider(id: string): Provider | undefined;
      registerProvider(provider: Provider): void;
    };
  },
  policy: AuthPolicy,
  audit: string,
): void {
  if (context.model?.provider !== (policy.modelProvider ?? policy.provider))
    throw new Error("Selected provider differs from the authentication policy");
  if (!policy.refreshAllowed && policy.expiresAt !== null)
    assertAuthLifetime(policy.expiresAt, 1000);
  const provider = context.modelRegistry.getProvider(policy.provider);
  if (!provider) throw new Error("Selected provider is unavailable to the authentication guard");
  if (policy.claudeCredentialFile) {
    if (!policy.refreshAllowed)
      throw new Error("Claude-file authentication requires dedicated refresh mode");
    context.modelRegistry.registerProvider(
      observeClaudeFileAuthentication(provider, audit, policy.claudeCredentialFile),
    );
  } else if (policy.refreshAllowed) {
    context.modelRegistry.registerProvider(observeOAuthRefresh(provider, audit));
  } else if (provider.auth.oauth && provider.auth.oauth.refresh !== denyOAuthRefresh) {
    context.modelRegistry.registerProvider(withoutOAuthRefresh(provider));
    if (
      context.modelRegistry.getProvider(policy.provider)?.auth.oauth?.refresh !== denyOAuthRefresh
    )
      throw new Error("The connector cannot enforce the no-refresh authentication policy");
  }
}
/** This harness-only guard is loaded last and never mutates Pi installation files. */
export default function authGuard(pi: ExtensionAPI): void {
  const policyPath = process.env.CAPABILITY_AUTH_POLICY;
  if (!policyPath) throw new Error("The capability authentication policy is required");
  const decoded: unknown = JSON.parse(readFileSync(policyPath, "utf8"));
  if (!decoded || typeof decoded !== "object")
    throw new Error("Invalid capability authentication policy");
  const raw = decoded as Record<string, unknown>;
  if (
    typeof raw.provider !== "string" ||
    !raw.provider ||
    !(
      raw.expiresAt === null ||
      (typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt))
    ) ||
    typeof raw.refreshAllowed !== "boolean" ||
    (raw.modelProvider !== undefined &&
      (typeof raw.modelProvider !== "string" || !raw.modelProvider)) ||
    (raw.claudeCredentialFile !== undefined &&
      (raw.claudeCredentialFile !== "/state/home/.claude/.credentials.json" ||
        raw.provider !== "anthropic" ||
        !raw.refreshAllowed))
  )
    throw new Error("Invalid capability authentication policy");
  const policy: AuthPolicy = {
    provider: raw.provider,
    expiresAt: raw.expiresAt,
    refreshAllowed: raw.refreshAllowed,
    ...(typeof raw.modelProvider === "string" && { modelProvider: raw.modelProvider }),
    ...(typeof raw.claudeCredentialFile === "string" && {
      claudeCredentialFile: raw.claudeCredentialFile,
    }),
  };
  const guard = (_event: unknown, context: ExtensionContext) => {
    try {
      applyAuthenticationPolicy(
        context,
        policy,
        path.join(path.dirname(policyPath), "auth-secrets.jsonl"),
      );
    } catch (error) {
      context.abort();
      throw error;
    }
  };
  pi.on("session_start", guard);
  pi.on("before_agent_start", guard);
  pi.on("before_provider_request", guard);
}
