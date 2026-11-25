import type { GithubCredentials } from "#github/client.ts";
import type { GithubRequestCoordinator } from "#github/request-coordinator.ts";

/** Local connection metadata. Tokens never belong in profiles or project preferences. */
interface ProfileBase {
  readonly id: string;
  readonly label: string;
  readonly login?: string;
}
export type GithubProfile = ProfileBase &
  (
    | { readonly kind: "device"; readonly clientId: string }
    | {
        readonly kind: "app";
        readonly appId: number;
        readonly installationId: number;
        readonly privateKeyPath: string;
      }
    | { readonly kind: "pat" }
  );

/** Only the owner-only credential file may persist these values. */
export type GithubSecret =
  | { readonly kind: "pat"; readonly token: string }
  | {
      readonly kind: "device";
      readonly accessToken: string;
      readonly expiresAt?: number;
      readonly refreshToken?: string;
      readonly refreshExpiresAt?: number;
    };

/** A transaction holds the inter-process lock through refresh and its atomic save. */
export interface GithubSecretUpdate<T> {
  readonly secret: GithubSecret | undefined;
  readonly value: T;
}
export interface GithubConnectionStorage {
  listProfiles(signal?: AbortSignal): Promise<GithubProfile[]>;
  getProfile(id: string, signal?: AbortSignal): Promise<GithubProfile | undefined>;
  saveProfile(profile: GithubProfile, secret?: GithubSecret, signal?: AbortSignal): Promise<void>;
  removeProfile(id: string, signal?: AbortSignal): Promise<void>;
  /** Capture a non-secret generation before asking the user to confirm removal. */
  snapshotRemoval(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ profile: GithubProfile; epoch: string } | undefined>;
  /** Never remove a profile which changed since the snapshot. */
  removeProfileIfUnchanged(id: string, epoch: string, signal?: AbortSignal): Promise<boolean>;
  getGlobalDefault(signal?: AbortSignal): Promise<string | undefined>;
  setGlobalDefault(id: string | undefined, signal?: AbortSignal): Promise<void>;
  /** Resolve legacy project precedence or an explicitly preferred global choice atomically. */
  getGlobalDefaultChoice(
    signal?: AbortSignal,
  ): Promise<{ id: string | undefined; preferred: boolean }>;
  /** Select the global default for new sessions, overriding older project defaults. */
  setGlobalDefaultForNewSessions(id: string, signal?: AbortSignal): Promise<void>;
  getProjectDefault(project: string, signal?: AbortSignal): Promise<string | undefined>;
  ensureLegacyDefault(
    project: string,
    load: () => Promise<Extract<GithubProfile, { kind: "app" }> | undefined>,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  setProjectDefault(project: string, id: string | undefined, signal?: AbortSignal): Promise<void>;
  withSecret<T>(
    id: string,
    update: (current: GithubSecret | undefined) => Promise<GithubSecretUpdate<T>>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export type GithubVerifiedIdentity = GithubCredentials["identity"];
export interface GithubDeviceCode {
  readonly verificationUri: string;
  readonly userCode: string;
  readonly expiresAt: number;
}
export interface GithubAuthOptions {
  readonly coordinator?: GithubRequestCoordinator;
  /** Upstream quota owner hint, never proof of account identity. */
  readonly quotaOwner?: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}
