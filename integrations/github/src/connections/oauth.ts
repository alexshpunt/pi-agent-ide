import type {
  GithubAuthOptions,
  GithubDeviceCode,
  GithubSecret,
  GithubVerifiedIdentity,
} from "./types.ts";
import { createHash } from "node:crypto";
import { githubRequestCoordinator, GithubNotSentError } from "#github/request-coordinator.ts";
import {
  GithubRateLimitError,
  isGithubRateLimitResponse,
  rateLimitInfoFromHeaders,
} from "#github/rate-limit.ts";

type DeviceSecret = Extract<GithubSecret, { kind: "device" }>;
type JsonObject = Record<string, unknown>;
const deviceEndpoint = "https://github.com/login/device/code";
const tokenEndpoint = "https://github.com/login/oauth/access_token";
const maximumBytes = 65_536;
const requestTimeout = 15_000;

/** Errors expose only fixed codes, never GitHub's response body or credential values. */
class AuthFailure extends Error {}
function fail(code: string): never {
  throw new AuthFailure(code);
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) fail("GH_AUTH_CANCELLED");
}
function object(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function credential(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}
function validClient(clientId: unknown): void {
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId))
    fail("GH_AUTH_INVALID_INPUT");
}
function positiveSeconds(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) > 0 &&
    Number(value) <= Math.floor(Number.MAX_SAFE_INTEGER / 1000)
  );
}
function deadline(now: number, seconds: unknown): number {
  if (!positiveSeconds(seconds) || !Number.isSafeInteger(now + seconds * 1000))
    fail("GH_AUTH_RESPONSE_INVALID");
  return now + seconds * 1000;
}
function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new AuthFailure("GH_AUTH_CANCELLED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    // Attach rejection handling even if creating the promise synchronously aborted the signal.
    if (signal.aborted) abort();
  });
}
async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  check(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new AuthFailure("GH_AUTH_CANCELLED"));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/** Small auth-only JSON boundary. Resource operations continue using GithubClient. */
async function requestJson(
  url: string,
  init: RequestInit,
  options: GithubAuthOptions,
): Promise<{ data: JsonObject; response: Response }> {
  check(options.signal);
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(requestTimeout),
  ]);
  const coordinator = options.coordinator ?? githubRequestCoordinator;
  const owner = options.quotaOwner;
  if (!owner) fail("GH_AUTH_INVALID_INPUT");
  let response: Response;
  try {
    response = await waitFor(
      coordinator.fetch(
        owner,
        url,
        { ...init, redirect: "error", signal },
        { fetcher: options.fetcher ?? fetch },
      ),
      signal,
    );
    check(signal);
  } catch (error) {
    if (error instanceof GithubRateLimitError || error instanceof GithubNotSentError) throw error;
    check(options.signal);
    if (signal.aborted) fail("GH_AUTH_TIMEOUT");
    fail("GH_AUTH_REQUEST_FAILED");
  }
  if (isGithubRateLimitResponse(response.status, response.headers)) {
    cancelBody(response);
    throw new GithubRateLimitError(rateLimitInfoFromHeaders(response.headers, undefined, true));
  }
  const json = /^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "");
  const secondaryCandidate = response.status === 403 && json;
  if ((!response.ok && !secondaryCandidate) || response.redirected) {
    cancelBody(response);
    if (response.redirected || (response.status >= 300 && response.status < 400))
      fail("GH_AUTH_REDIRECT_BLOCKED");
    if (response.status === 401) fail("GH_AUTH_UNAUTHORIZED");
    if (response.status === 403) fail("GH_AUTH_FORBIDDEN");
    if (response.status >= 500) fail("GH_AUTH_SERVER_FAILED");
    fail("GH_AUTH_HTTP_REJECTED");
  }
  if (!json) {
    cancelBody(response);
    fail("GH_AUTH_RESPONSE_INVALID");
  }
  const sizeHeader = response.headers.get("content-length");
  if (sizeHeader && /^\d+$/.test(sizeHeader) && Number(sizeHeader) > maximumBytes) {
    cancelBody(response);
    fail(secondaryCandidate ? "GH_AUTH_FORBIDDEN" : "GH_AUTH_RESPONSE_INVALID");
  }
  const reader = response.body?.getReader();
  if (!reader) fail("GH_AUTH_RESPONSE_INVALID");
  let size = 0;
  const chunks: Uint8Array[] = [];
  let data: unknown;
  try {
    for (;;) {
      const part = await waitFor(reader.read(), signal);
      check(signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) fail("GH_AUTH_RESPONSE_INVALID");
      chunks.push(part.value);
    }
    data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)),
    );
    if (!object(data)) fail("GH_AUTH_RESPONSE_INVALID");
  } catch {
    void reader.cancel().catch(() => {});
    check(options.signal);
    if (signal.aborted) fail("GH_AUTH_TIMEOUT");
    fail(secondaryCandidate ? "GH_AUTH_FORBIDDEN" : "GH_AUTH_RESPONSE_INVALID");
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  if (isGithubRateLimitResponse(response.status, response.headers, data)) {
    await coordinator.observe(owner, url, response, data);
    throw new GithubRateLimitError(rateLimitInfoFromHeaders(response.headers, undefined, true));
  }
  if (!response.ok) fail("GH_AUTH_FORBIDDEN");
  return { data, response };
}
function postForm(
  url: string,
  fields: Record<string, string>,
  options: GithubAuthOptions,
): Promise<JsonObject> {
  return requestJson(
    url,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    },
    { ...options, quotaOwner: `oauth-client:${fields.client_id}` },
  ).then(({ data }) => data);
}
function parseToken(data: JsonObject, now: number): DeviceSecret {
  if (!credential(data.access_token) || data.token_type !== "bearer")
    fail("GH_AUTH_RESPONSE_INVALID");
  if (data.expires_in === undefined) {
    if (data.refresh_token !== undefined || data.refresh_token_expires_in !== undefined)
      fail("GH_AUTH_RESPONSE_INVALID");
    return { kind: "device", accessToken: data.access_token };
  }
  if (!credential(data.refresh_token)) fail("GH_AUTH_RESPONSE_INVALID");
  return {
    kind: "device",
    accessToken: data.access_token,
    expiresAt: deadline(now, data.expires_in),
    refreshToken: data.refresh_token,
    refreshExpiresAt: deadline(now, data.refresh_token_expires_in),
  };
}
function deviceError(data: JsonObject): never {
  switch (data.error) {
    case "access_denied": {
      return fail("GH_AUTH_ACCESS_DENIED");
    }
    case "expired_token":
    case "token_expired": {
      return fail("GH_AUTH_DEVICE_EXPIRED");
    }
    case "device_flow_disabled": {
      return fail("GH_AUTH_DEVICE_DISABLED");
    }
    default: {
      return fail("GH_AUTH_DEVICE_REJECTED");
    }
  }
}

/** Authorize through the user's own App. Only the public code/URL reach the UI callback. */
export async function deviceLogin(
  clientId: string,
  onCode: (code: GithubDeviceCode) => void | Promise<void>,
  options: GithubAuthOptions & {
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<DeviceSecret> {
  check(options.signal);
  validClient(clientId);
  if (typeof onCode !== "function") fail("GH_AUTH_INVALID_INPUT");
  const now = options.now ?? Date.now;
  const first = await postForm(deviceEndpoint, { client_id: clientId }, options);
  if (first.error !== undefined) deviceError(first);
  if (
    !credential(first.device_code) ||
    typeof first.user_code !== "string" ||
    !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(first.user_code) ||
    first.verification_uri !== "https://github.com/login/device" ||
    !positiveSeconds(first.expires_in) ||
    first.expires_in > 86_400 ||
    (first.interval !== undefined && (!positiveSeconds(first.interval) || first.interval > 86_400))
  )
    fail("GH_AUTH_RESPONSE_INVALID");
  const expiresAt = deadline(now(), first.expires_in);
  let interval = (first.interval ?? 5) * 1000;
  const expirySignal = AbortSignal.timeout(first.expires_in * 1000);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), expirySignal]);
  const operation = { ...options, signal };
  try {
    await waitFor(
      Promise.resolve(
        onCode({ verificationUri: first.verification_uri, userCode: first.user_code, expiresAt }),
      ),
      signal,
    );
    check(signal);
    for (;;) {
      const remaining = expiresAt - now();
      if (remaining <= 0) fail("GH_AUTH_DEVICE_EXPIRED");
      await waitFor((options.wait ?? pause)(Math.min(interval, remaining), signal), signal);
      check(signal);
      if (now() >= expiresAt) fail("GH_AUTH_DEVICE_EXPIRED");
      const data = await postForm(
        tokenEndpoint,
        {
          client_id: clientId,
          device_code: first.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        operation,
      );
      if (now() >= expiresAt) fail("GH_AUTH_DEVICE_EXPIRED");
      if (data.error === "authorization_pending") continue;
      if (data.error === "slow_down") {
        if (data.interval !== undefined && !positiveSeconds(data.interval))
          fail("GH_AUTH_RESPONSE_INVALID");
        interval = Math.max(interval + 5000, (data.interval ?? 0) * 1000);
        continue;
      }
      if (data.error !== undefined) deviceError(data);
      return parseToken(data, now());
    }
  } catch (error) {
    check(options.signal);
    if (expirySignal.aborted) fail("GH_AUTH_DEVICE_EXPIRED");
    if (
      error instanceof AuthFailure ||
      error instanceof GithubRateLimitError ||
      error instanceof GithubNotSentError
    )
      throw error;
    fail("GH_AUTH_DEVICE_REJECTED");
  }
}

function isDeviceCredential(value: unknown): value is DeviceSecret {
  return object(value) && value.kind === "device" && credential(value.accessToken);
}

/** Device-origin refresh does not need a publisher's client_secret. Caller serializes persistence. */
export async function refreshUserToken(
  clientId: string,
  secret: DeviceSecret,
  options: GithubAuthOptions = {},
): Promise<DeviceSecret> {
  check(options.signal);
  validClient(clientId);
  if (!isDeviceCredential(secret)) fail("GH_AUTH_INVALID_INPUT");
  if (secret.refreshToken === undefined) fail("GH_AUTH_REFRESH_REQUIRED");
  if (!credential(secret.refreshToken)) fail("GH_AUTH_INVALID_INPUT");
  const now = options.now ?? Date.now;
  if (secret.refreshExpiresAt !== undefined) {
    if (!Number.isSafeInteger(secret.refreshExpiresAt)) fail("GH_AUTH_INVALID_INPUT");
    if (secret.refreshExpiresAt <= now()) fail("GH_AUTH_REFRESH_EXPIRED");
  }
  const data = await postForm(
    tokenEndpoint,
    { client_id: clientId, grant_type: "refresh_token", refresh_token: secret.refreshToken },
    options,
  );
  if (data.error !== undefined) fail("GH_AUTH_REFRESH_REJECTED");
  const next = parseToken(data, now());
  if (!next.refreshToken || next.refreshToken === secret.refreshToken)
    fail("GH_AUTH_RESPONSE_INVALID");
  return next;
}

/** Verify the selected personal credential; never treat a profile label as proof of identity. */
export async function verifyUser(
  token: string,
  options: GithubAuthOptions = {},
): Promise<GithubVerifiedIdentity> {
  check(options.signal);
  if (!credential(token)) fail("GH_AUTH_INVALID_INPUT");
  const { data, response } = await requestJson(
    "https://api.github.com/user",
    {
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    },
    {
      ...options,
      quotaOwner:
        options.quotaOwner ?? `user-unverified:${createHash("sha256").update(token).digest("hex")}`,
    },
  );
  if (
    typeof data.id !== "number" ||
    !Number.isSafeInteger(data.id) ||
    data.id <= 0 ||
    typeof data.login !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(data.login) ||
    (data.type !== undefined && data.type !== "User") ||
    [data.login, data.name, data.email].some(
      (value) => typeof value === "string" && value.includes(token),
    ) ||
    (data.name !== null &&
      data.name !== undefined &&
      (typeof data.name !== "string" ||
        data.name.length > 256 ||
        /[\x00-\x1f\x7f-\x9f]/.test(data.name))) ||
    (data.email !== null &&
      data.email !== undefined &&
      (typeof data.email !== "string" ||
        data.email.length > 320 ||
        /[\x00-\x1f\x7f-\x9f]/.test(data.email) ||
        !/^[^\s@]+@[^\s@]+$/.test(data.email)))
  )
    fail("GH_AUTH_UNVERIFIED");
  // A cold identity read can exhaust the last request before the upstream owner was known.
  await (options.coordinator ?? githubRequestCoordinator).observe(
    `user:${data.login.toLowerCase()}`,
    "https://api.github.com/user",
    response,
  );
  return {
    login: data.login,
    name: typeof data.name === "string" && data.name ? data.name : data.login,
    email:
      typeof data.email === "string" && data.email
        ? data.email
        : `${data.id}+${data.login}@users.noreply.github.com`,
  };
}
