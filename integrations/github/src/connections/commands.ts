import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import * as Pi from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { GithubAppAuth, GithubAppRegistration } from "#github/auth.ts";
import { GithubRateLimitError, safeRateLimitInfo } from "#github/rate-limit.ts";
import { deviceLogin, verifyUser } from "./oauth.ts";
import { MaskedGithubInput } from "./secret-input.ts";
import type { GithubConnections } from "./manager.ts";
import type { GithubAuthOptions, GithubDeviceCode, GithubProfile, GithubSecret } from "./types.ts";

type SessionHook = (event: unknown, context: GithubCommandContext) => Promise<void>;
type GithubCommandHandler = (args: string, context: GithubCommandContext) => Promise<void>;

export type GithubCommandContext = Pick<ExtensionContext, "cwd" | "mode" | "hasUI" | "signal"> & {
  ui: Pick<ExtensionContext["ui"], "confirm" | "custom" | "input" | "notify" | "select">;
  sessionManager: {
    getBranch(): readonly { type: string; customType?: string; data?: unknown }[];
  };
};

export interface GithubCommandRegistry extends Pick<ExtensionAPI, "appendEntry"> {
  on(event: "session_start", handler: SessionHook): () => void;
  on(event: "session_tree", handler: SessionHook): () => void;
  registerCommand(
    name: string,
    options: Omit<Parameters<ExtensionAPI["registerCommand"]>[1], "handler"> & {
      handler: GithubCommandHandler;
    },
  ): void;
}

const sessionEntry = "pi-agent-github-profile";
const usage =
  "Use /github to manage connections, or use status, list, switch [profile], global [profile], default [profile], reset, or logout [profile].";
class AuthUiError extends Error {}
const cancelled = new Error("GH_AUTH_CANCELLED");
function interactive(context: GithubCommandContext): void {
  if (!context.hasUI)
    throw new AuthUiError(
      "This action needs interactive Pi. Existing saved connections work without UI.",
    );
}
function message(error: unknown): string {
  if (error instanceof GithubRateLimitError) {
    const info = safeRateLimitInfo(error.rateLimit);
    const reset = info?.resetAt === undefined ? undefined : new Date(info.resetAt);
    const deadline = reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : undefined;
    return deadline
      ? `GitHub rate limit: requests are paused until ${deadline}. No account switch or automatic retry was attempted.`
      : `GitHub rate limit: requests are paused${info?.retryAfterMs === undefined ? "" : ` for ${Math.ceil(info.retryAfterMs / 1000)} seconds`}. No account switch or automatic retry was attempted.`;
  }
  if (error instanceof AuthUiError) return error.message;
  const code = error instanceof Error ? error.message : "";
  const known: Partial<Record<string, string>> = {
    GH_CONNECTION_REQUIRED:
      "No GitHub connection selected. Use /github add, or choose a saved connection.",
    GH_CONNECTION_MISSING:
      "The selected GitHub connection was removed. Choose another connection explicitly.",
    GH_CONNECTION_CHANGED:
      "The GitHub connection changed. Read the target again before continuing.",
    GH_CANCELLED: "GitHub sign-in cancelled.",
    GH_AUTH_CANCELLED: "GitHub sign-in cancelled.",
    GH_AUTH_EXPIRED: "GitHub authorization expired. Sign in again or replace the saved PAT.",
    GH_CONNECTION_CANCELLED: "GitHub sign-in cancelled.",
    GH_CONNECTION_CREDENTIALS_MISSING:
      "The selected connection has no saved credential. Add it again and switch explicitly.",
    GH_AUTH_REQUEST_FAILED:
      "Could not reach GitHub. Check this machine's network, DNS and proxy connection; changing accounts will not fix a network failure.",
    GH_AUTH_TIMEOUT:
      "The GitHub authorization request timed out. Check network connectivity and try again.",
    GH_TIMEOUT: "GitHub request admission timed out. No queued request was sent.",
    GH_RATE_QUEUE_FULL: "GitHub request admission is busy. No queued request was sent.",
    GH_RATE_STATE_UNSAFE:
      "GitHub rate-limit coordination requires protected local state. Inspect the operation before trying again.",
    GH_AUTH_UNAUTHORIZED:
      "GitHub rejected the credential (HTTP 401). Check the selected token or App ID and signing key.",
    GH_AUTH_FORBIDDEN:
      "GitHub denied authorization (HTTP 403) without a confirmed cooldown. Check the selected connection's permissions, installation and organization policy.",
    GH_AUTH_RATE_LIMITED: "GitHub rate-limited authorization (HTTP 429). Wait before trying again.",
    GH_AUTH_SERVER_FAILED: "GitHub could not complete authorization (HTTP 5xx). Try again later.",
    GH_AUTH_REDIRECT_BLOCKED:
      "GitHub authorization redirected unexpectedly. No credentials were forwarded; check the network or proxy configuration.",
    GH_AUTH_HTTP_REJECTED:
      "GitHub rejected the authorization request. Check the App identifiers and sign-in method.",
    GH_AUTH_DEVICE_DISABLED:
      "Enable device flow in your GitHub App settings, then sign in with its Client ID (not numeric App ID).",
    GH_AUTH_DEVICE_REJECTED:
      "GitHub rejected device sign-in. Check your App Client ID and that device flow is enabled.",
    GH_AUTH_DEVICE_EXPIRED: "The GitHub sign-in code expired. Start sign-in again for a new code.",
    GH_AUTH_ACCESS_DENIED: "GitHub sign-in was denied. No connection was added.",
    GH_AUTH_INVALID_INPUT:
      "Invalid sign-in input. User sign-in needs your App Client ID; bot sign-in needs the numeric App ID.",
    GH_AUTH_RESPONSE_INVALID:
      "GitHub returned an invalid authorization response. No credential was saved; try again.",
    GH_AUTH_UNVERIFIED:
      "GitHub could not verify the account identity. No unverified connection will be used.",
    GH_AUTH_REFRESH_REQUIRED: "The selected connection cannot refresh its token. Sign in again.",
    GH_AUTH_REFRESH_EXPIRED: "The selected connection's refresh token expired. Sign in again.",
    GH_AUTH_REFRESH_REJECTED:
      "GitHub rejected the selected connection's token refresh. Sign in again.",
    GH_CONNECTION_STORE_UNSAFE:
      "GitHub credential storage must use owner-only regular files (600) in an owner-only directory (700), without symlinks or hard links.",
    GH_CONNECTION_STORE_UNSUPPORTED:
      "Protected GitHub credential storage requires a POSIX host with file ownership and permissions.",
    GH_CONNECTION_STORE_INVALID:
      "The local GitHub profile or credential data is invalid. Check its format without sharing its contents.",
    GH_CONNECTION_STORE_FAILED:
      "Could not read or save local GitHub credentials. Check local file access, format and available disk space.",
    GH_CONNECTION_STORE_LOCKED:
      "GitHub credential storage is busy. Wait for the other process and try again.",
    GH_CONNECTION_STORE_LOCK:
      "GitHub credential storage lost its lock. Inspect the saved connection before retrying.",
    "GitHub authorization request failed. No personal credential was used.":
      "Could not reach GitHub. Check this machine's network, DNS and proxy connection; changing accounts will not fix a network failure.",
    "GitHub App private key must be a valid owner-only regular PEM file (chmod 600), not a symlink.":
      "The App key must be a valid owner-only regular RSA PEM file (chmod 600), without symlinks or hard links. Check the file path; do not paste its contents.",
  };
  const appStatus = /^GitHub authorization API (\d{3})\. No personal credential was used\.$/u.exec(
    code,
  )?.[1];
  const statusCode =
    appStatus === "401"
      ? "GH_AUTH_UNAUTHORIZED"
      : appStatus === "403"
        ? "GH_AUTH_FORBIDDEN"
        : appStatus === "429"
          ? "GH_AUTH_RATE_LIMITED"
          : appStatus?.startsWith("5")
            ? "GH_AUTH_SERVER_FAILED"
            : "";
  return (
    known[code] ??
    known[statusCode] ??
    "GitHub authorization failed. Use /github status to check the selected connection; no other account was tried."
  );
}
function required(value: string | undefined): string {
  if (value === undefined || !value.trim()) throw cancelled;
  return value.trim();
}
function mode(profile: GithubProfile): string {
  return profile.kind === "app"
    ? "App bot"
    : profile.kind === "device"
      ? "GitHub user"
      : "PAT user";
}

/** A terminal-only secret prompt: entered values never enter chat, tool arguments or notifications. */
async function tokenInput(context: GithubCommandContext): Promise<string | undefined> {
  interactive(context);
  if (context.mode !== "tui")
    throw new AuthUiError(
      "PAT entry needs the Pi terminal UI. Configure a saved local connection for non-terminal use.",
    );
  return context.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const input = new MaskedGithubInput();
    let error = "";
    let finished = false;
    const finish = (value: string | undefined) => {
      if (!finished) {
        finished = true;
        done(value);
      }
    };
    input.onSubmit = (value) => {
      if (!/^[\x21-\x7e]{1,16384}$/u.test(value)) {
        error = "Enter one token without spaces or control characters.";
        tui.requestRender();
        return;
      }
      finish(value);
    };
    input.onEscape = () => finish(undefined);
    const abort = () => finish(undefined);
    context.signal?.addEventListener("abort", abort, { once: true });
    return {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      render(width: number) {
        return [
          theme.fg("accent", "Personal access token"),
          ...input.render(Math.max(1, width)),
          theme.fg(
            error ? "error" : "dim",
            error || "Input is hidden. Enter connects; Esc cancels.",
          ),
        ].map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (matchesKey(data, "ctrl+c")) finish(undefined);
        else input.handleInput(data);
        tui.requestRender();
      },
      invalidate() {
        input.invalidate();
      },
      dispose() {
        context.signal?.removeEventListener("abort", abort);
        input.onSubmit = undefined;
        input.onEscape = undefined;
        input.setValue("");
      },
    };
  });
}

function getLoginDialog(host: { LoginDialogComponent?: typeof Pi.LoginDialogComponent }) {
  return host.LoginDialogComponent;
}

async function loginDevice(
  clientId: string,
  context: GithubCommandContext,
  options: GithubAuthOptions,
): Promise<Extract<GithubSecret, { kind: "device" }> | undefined> {
  interactive(context);
  if (context.mode !== "tui")
    throw new AuthUiError(
      "Device sign-in needs the Pi terminal UI. Use a saved connection for non-terminal operation.",
    );
  // Pi 1.4 exposes its device-login dialog; keep the existing screen for older versions.
  const Dialog = getLoginDialog(Pi);
  if (Dialog) {
    let failure: unknown;
    const result = await context.ui.custom<Extract<GithubSecret, { kind: "device" }> | undefined>(
      (tui, _theme, _keys, done) => {
        const dialog = new Dialog(tui, "github", () => done(undefined), "GitHub");
        const signal = context.signal
          ? AbortSignal.any([context.signal, dialog.signal])
          : dialog.signal;
        dialog.showWaiting("Requesting a sign-in code from GitHub…");
        const runLogin = async () => {
          let secret: Extract<GithubSecret, { kind: "device" }> | undefined;
          try {
            secret = await deviceLogin(
              clientId,
              (code) => {
                dialog.showDeviceCode(code);
                dialog.showWaiting("Waiting for approval in your browser…");
              },
              { ...options, signal },
            );
          } catch (error) {
            if (!signal.aborted) failure = error;
          }
          done(secret);
        };
        void runLogin();
        return dialog;
      },
    );
    if (failure) throw new AuthUiError(message(failure));
    return result;
  }
  const controller = new AbortController();
  const signal = context.signal
    ? AbortSignal.any([context.signal, controller.signal])
    : controller.signal;
  const outcome = await context.ui.custom<
    { secret?: Extract<GithubSecret, { kind: "device" }>; failure?: string } | undefined
  >((tui, theme, keys, done) => {
    let code: GithubDeviceCode | undefined;
    let finished = false;
    const finish = (
      value: { secret?: Extract<GithubSecret, { kind: "device" }>; failure?: string } | undefined,
    ) => {
      if (!finished) {
        finished = true;
        done(value);
      }
    };
    void deviceLogin(
      clientId,
      (value) => {
        code = value;
        tui.requestRender();
      },
      { ...options, signal },
    )
      .then((secret) => finish({ secret }))
      .catch((error: unknown) => finish(signal.aborted ? undefined : { failure: message(error) }));
    return {
      render(width: number) {
        return [
          theme.fg("accent", "GitHub sign-in through your App"),
          ...(code
            ? [
                `Open: ${code.verificationUri}`,
                `Enter code: ${code.userCode}`,
                "Waiting for approval in your browser.",
              ]
            : ["Requesting a sign-in code from GitHub..."]),
          theme.fg("dim", "Esc cancels."),
        ].map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) {
          controller.abort();
          finish(undefined);
        }
      },
      invalidate() {},
      dispose() {
        controller.abort();
      },
    };
  });
  if (outcome?.failure) throw new AuthUiError(outcome.failure);
  return outcome?.secret;
}

/** Register user commands independently of IDE/standalone tool selection. */
export function registerGithubAuthCommands(
  pi: GithubCommandRegistry,
  connections: GithubConnections,
  options: GithubAuthOptions = {},
): void {
  options = { ...options, coordinator: options.coordinator ?? connections.coordinator };
  const selectSession = (id: string | undefined) => {
    connections.useProfile(id);
    pi.appendEntry(sessionEntry, { profileId: id ?? null });
  };
  const restore = async (context: GithubCommandContext) => {
    const entries = context.sessionManager.getBranch();
    let selected: string | undefined;
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== sessionEntry) continue;
      const data = entry.data as { profileId?: unknown } | undefined;
      if (data?.profileId === null) selected = undefined;
      else if (typeof data?.profileId === "string") selected = data.profileId;
    }
    connections.useProfile(selected);
    if (context.hasUI) {
      try {
        await connections.capture(context.cwd, context.signal);
      } catch (error) {
        if (
          error instanceof Error &&
          ["GH_CONNECTION_REQUIRED", "GH_CONNECTION_MISSING"].includes(error.message)
        )
          return;
        if (!context.signal?.aborted) context.ui.notify(message(error), "warning");
      }
    }
  };
  pi.on("session_start", async (_event, context) => restore(context));
  pi.on("session_tree", async (_event, context) => restore(context));

  const selectionLabels = async (context: GithubCommandContext) => {
    const defaultId = await connections.store.getGlobalDefault(context.signal);
    let activeId: string | undefined;
    try {
      activeId = (await connections.capture(context.cwd, context.signal)).profile.id;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !["GH_CONNECTION_REQUIRED", "GH_CONNECTION_MISSING"].includes(error.message)
      )
        throw error;
    }
    return (profile: GithubProfile) =>
      `${profile.label}${profile.id === activeId ? " [active]" : ""}${profile.id === defaultId ? " [default]" : ""} · ${mode(profile)} · ${profile.id}`;
  };
  const choose = async (context: GithubCommandContext): Promise<GithubProfile | undefined> => {
    interactive(context);
    const profiles = await connections.store.listProfiles(context.signal);
    if (!profiles.length) throw new AuthUiError("No saved GitHub connections. Use /github add.");
    const labels = profiles.map(await selectionLabels(context));
    const selected = await context.ui.select("Choose a GitHub connection", labels, {
      signal: context.signal,
    });
    return selected === undefined ? undefined : profiles[labels.indexOf(selected)];
  };
  const chooseRemoval = async (context: GithubCommandContext) => {
    interactive(context);
    const profiles = await connections.store.listProfiles(context.signal);
    const label = await selectionLabels(context);
    const snapshots: NonNullable<Awaited<ReturnType<typeof connections.store.snapshotRemoval>>>[] =
      [];
    for (const profile of profiles) {
      const snapshot = await connections.store.snapshotRemoval(profile.id, context.signal);
      if (snapshot) snapshots.push(snapshot);
    }
    if (!snapshots.length)
      throw new AuthUiError("No saved GitHub connections. Use /github to log in.");
    const labels = snapshots.map(({ profile }) => label(profile));
    const selected = await context.ui.select("Choose a GitHub connection", labels, {
      signal: context.signal,
    });
    return selected === undefined ? undefined : snapshots[labels.indexOf(selected)];
  };
  const add = async (context: GithubCommandContext, selectedKind?: string) => {
    interactive(context);
    const kind =
      selectedKind ??
      (await context.ui.select(
        "Add your GitHub connection",
        ["GitHub user through my App", "My App installation bot", "Personal access token"],
        { signal: context.signal },
      ));
    if (!kind) return;
    const id = randomUUID();
    let profile: GithubProfile;
    let secret: GithubSecret | undefined;
    let login: string;
    const authOptions = { ...options, signal: context.signal };
    if (kind === "GitHub user through my App") {
      const clientId = required(
        await context.ui.input("Your GitHub App Client ID (device flow must be enabled)", "Iv...", {
          signal: context.signal,
        }),
      );
      const value = await loginDevice(clientId, context, authOptions);
      if (!value) return;
      secret = value;
      login = (await verifyUser(value.accessToken, authOptions)).login;
      profile = { id, label: `${login} · GitHub user`, login, kind: "device", clientId };
    } else if (kind === "Personal access token") {
      const token = required(await tokenInput(context));
      login = (await verifyUser(token, authOptions)).login;
      profile = { id, label: `${login} · PAT`, login, kind: "pat" };
      secret = { kind: "pat", token };
    } else {
      const rawId = required(
        await context.ui.input("Your GitHub App ID", "App ID, not Client ID", {
          signal: context.signal,
        }),
      );
      if (!/^[1-9][0-9]*$/u.test(rawId) || !Number.isSafeInteger(Number(rawId)))
        throw new AuthUiError("Enter a positive numeric App ID.");
      const rawPath = required(
        await context.ui.input(
          "Absolute path to your private-key file (do not paste the key)",
          "/home/you/app.pem",
          { signal: context.signal },
        ),
      );
      const privateKeyPath = rawPath.startsWith("~/")
        ? path.join(homedir(), rawPath.slice(2))
        : rawPath;
      const app = new GithubAppRegistration({ appId: Number(rawId), privateKeyPath }, options);
      let page = 1;
      let installationId: number | undefined;
      while (installationId === undefined) {
        const result = await app.listInstallations(page, context.signal);
        const available = result.installations.filter((installation) => !installation.suspended);
        const labels = available.map(
          (installation) =>
            `${installation.account} · ${installation.repositories} repositories · ${installation.id}`,
        );
        if (result.hasMore) labels.push("Next page");
        if (!labels.length)
          throw new AuthUiError(
            "No active installations on this page. Install your App on the intended account and grant repository access.",
          );
        const selected = await context.ui.select("Choose your App installation", labels, {
          signal: context.signal,
        });
        if (selected === undefined) return;
        if (selected === "Next page") {
          page++;
          continue;
        }
        installationId = available[labels.indexOf(selected)]?.id;
      }
      const config = { appId: Number(rawId), installationId, privateKeyPath };
      const auth = new GithubAppAuth(config, options);
      try {
        await auth.initialize(context.signal);
        login = auth.identity.login;
      } finally {
        auth.clear();
      }
      profile = { id, label: login, login, kind: "app", ...config };
    }
    const label = await context.ui.input("Connection name", profile.label, {
      signal: context.signal,
    });
    if (label === undefined) return;
    profile = { ...profile, label: label.trim() || profile.label };
    await connections.store.saveProfile(profile, secret, context.signal);
    context.ui.notify(
      `Saved connection for ${login} (${mode(profile)}). Current connection unchanged. Use /github switch to select it.`,
      "info",
    );
  };

  const handler: GithubCommandHandler = async (args, context) => {
    try {
      let [action = "", id, ...extra] = args.trim().split(/\s+/u);
      if (extra.length) throw new AuthUiError(usage + " Enter secrets only in the hidden prompt.");
      if (!action && context.hasUI) {
        for (;;) {
          const selected = await context.ui.select(
            "GitHub connections",
            ["Log in", "Log out", "Select account"],
            { signal: context.signal },
          );
          if (!selected || context.signal?.aborted) return;
          if (selected === "Log in") {
            const method = await context.ui.select(
              "Log in to GitHub",
              ["Personal access token", "GitHub App"],
              { signal: context.signal },
            );
            if (method === "Personal access token") {
              context.ui.notify(
                "A personal access token acts as its owner within the token’s permissions. Enter it only in the private masked prompt.",
                "info",
              );
              await add(context, method);
            } else if (method === "GitHub App") {
              const kind = await context.ui.select(
                "GitHub App identity",
                ["GitHub user through my App", "My App installation bot"],
                { signal: context.signal },
              );
              if (kind) {
                context.ui.notify(
                  kind === "GitHub user through my App"
                    ? "Acts as you. Supply your App Client ID and enable device flow; access is limited by the App and your permissions."
                    : "Acts as the installed App bot. Supply your App ID and private-key file; access is limited to the installation and its permissions.",
                  "info",
                );
                await add(context, kind);
              }
            }
          } else if (selected === "Log out") await handler("logout", context);
          else if (selected === "Select account") {
            const scope = await context.ui.select(
              "Select account for",
              ["Global default for new sessions", "Current session only"],
              { signal: context.signal },
            );
            const route = (
              {
                "Global default for new sessions": "global",
                "Current session only": "switch",
              } as Record<string, string>
            )[scope ?? ""];
            if (route) await handler(route, context);
          }
        }
      }
      if (action === "switch") action = "use";
      if (action === "logout") action = "remove";
      if (id && ["status", "list", "reset"].includes(action)) throw new AuthUiError(usage);
      if (!action || action === "status") {
        const access = await connections.capture(context.cwd, context.signal);
        await access.credentials.initialize(context.signal);
        context.ui.notify(
          `GitHub: ${access.credentials.identity.login} · ${mode(access.profile)} · ${access.profile.label}`,
          "info",
        );
      } else if (action === "add") {
        if (id) throw new AuthUiError("Use /github add without credentials in the command line.");
        await add(context);
      } else if (action === "list") {
        const profiles = await connections.store.listProfiles(context.signal);
        context.ui.notify(
          profiles.length
            ? profiles
                .map((profile) => `${profile.id} · ${profile.label} · ${mode(profile)}`)
                .join("\n")
            : "No saved GitHub connections. Use /github add.",
          "info",
        );
      } else if (action === "clear-project" || action === "clear-global") {
        if (id) throw new AuthUiError(usage);
        if (action === "clear-project")
          await connections.store.setProjectDefault(context.cwd, undefined, context.signal);
        else await connections.store.setGlobalDefault(undefined, context.signal);
        context.ui.notify(
          `${action === "clear-project" ? "Project" : "Global"} default cleared for new sessions. Current session unchanged.`,
          "info",
        );
      } else if (action === "reset") {
        selectSession(undefined);
      } else if (["use", "default", "global", "remove"].includes(action)) {
        const removal =
          action === "remove"
            ? id
              ? await connections.store.snapshotRemoval(id, context.signal)
              : await chooseRemoval(context)
            : undefined;
        const profile =
          action === "remove"
            ? removal?.profile
            : id
              ? await connections.store.getProfile(id, context.signal)
              : await choose(context);
        if (!profile) {
          if (id) throw new AuthUiError("Unknown GitHub profile. Use /github list.");
          return;
        }
        if (action === "remove") {
          if (removal === undefined)
            throw new AuthUiError("Unknown GitHub profile. Use /github list.");
          interactive(context);
          const notice =
            profile.kind === "app"
              ? "Only this session's cached installation token can be revoked. The installation, App and private-key file remain, and other sessions may have tokens."
              : "This removes the local credential only. Revoke the token or App authorization in GitHub settings separately.";
          if (
            !(await context.ui.confirm(
              "Log out of this connection?",
              `${profile.label}\n${notice}`,
              { signal: context.signal },
            ))
          )
            return;
          const remote =
            profile.kind === "app"
              ? await connections.revokeCachedInstallationToken(profile.id, context.signal)
              : undefined;
          const remoteMessage =
            remote === undefined
              ? "Remote authorization was not revoked; revoke it in GitHub settings."
              : (
                  {
                    revoked: "The cached installation token was revoked.",
                    refused: "GitHub refused to revoke the cached installation token.",
                    unknown:
                      "The cached installation token revocation outcome is unknown; it was not retried.",
                    "not-sent": "The cached installation token revocation was not sent.",
                    "not-cached":
                      "There was no cached installation token in this session to revoke.",
                  } as const
                )[remote];
          let removed: boolean;
          try {
            removed = await connections.store.removeProfileIfUnchanged(profile.id, removal.epoch);
          } catch {
            context.ui.notify(
              `Local removal could not be confirmed; inspect /github list before trying again. ${remoteMessage}`,
              "error",
            );
            return;
          }
          if (!removed) {
            context.ui.notify(
              `Local connection changed or was replaced; it was not removed. ${remoteMessage}`,
              "warning",
            );
            return;
          }
          connections.invalidate(profile.id);
          const guidance =
            profile.kind === "app"
              ? " The App installation and external key files are unchanged; other sessions may retain tokens. Manage the installation on GitHub to remove its access."
              : " Other connections are unchanged.";
          context.ui.notify(
            `Removed local connection: ${profile.label}. ${remoteMessage}${guidance}`,
            "info",
          );
        } else {
          if (action === "default" || action === "global") {
            if (action === "default")
              await connections.store.setProjectDefault(context.cwd, profile.id, context.signal);
            else await connections.store.setGlobalDefaultForNewSessions(profile.id, context.signal);
            context.ui.notify(
              `${action === "default" ? "Project" : "Global"} default for new sessions: ${profile.label} (${mode(profile)}). Current session unchanged.${action === "default" ? " An explicitly selected global default takes precedence." : ""}`,
              "info",
            );
          } else {
            selectSession(profile.id);
            context.ui.notify(
              `Switched to ${profile.label} (${mode(profile)}); this session only.`,
              "info",
            );
          }
        }
      } else throw new AuthUiError(usage);
    } catch (error) {
      if (error === cancelled || context.signal?.aborted) return;
      context.ui.notify(message(error), "error");
    }
  };
  pi.registerCommand("github", {
    description: "Manage GitHub connections",
    handler,
  });
}
