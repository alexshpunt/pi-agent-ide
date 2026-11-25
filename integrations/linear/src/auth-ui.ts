import * as Pi from "@earendil-works/pi-coding-agent";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Input,
  Text,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import {
  APP_AUTH_SCOPES,
  runAuthCommand,
  type AuthRunner,
  type AuthStatus,
} from "./auth-process.ts";
import type { AuthConnection, AuthMethod, AuthRunOptions } from "./auth-process.ts";
import type { SessionConnectionSelection } from "./auth-session.ts";
import { openAuthorizationPage } from "./auth-browser.ts";
import { logoutConnection } from "./auth-logout.ts";

/** A fresh overlay owns secret input; neither the value nor the Input's plaintext render is displayed. */
export class MaskedAuthInput implements Component, Focusable {
  private readonly input = new Input();
  private complete = false;
  private active = false;
  get focused(): boolean {
    return this.active;
  }
  set focused(value: boolean) {
    this.active = value;
    this.input.focused = value;
  }
  constructor(
    private readonly title: string,
    done: (value: string | undefined) => void,
    private readonly refresh: () => void,
  ) {
    this.input.onSubmit = (value) => {
      const secret = value.trim();
      this.complete = true;
      this.input.setValue("");
      done(secret || undefined);
    };
    this.input.onEscape = () => {
      this.complete = true;
      this.input.setValue("");
      done(undefined);
    };
  }
  handleInput(data: string): void {
    if (this.complete) return;
    const previous = this.input.getValue();
    this.input.handleInput(data);
    if (Buffer.byteLength(this.input.getValue()) > 16_384) this.input.setValue(previous);
    this.refresh();
  }
  invalidate(): void {
    this.input.invalidate();
  }
  render(width: number): string[] {
    const count = Math.min(Array.from(this.input.getValue()).length, Math.max(0, width - 5));
    return [
      truncateToWidth(this.title, width),
      truncateToWidth(`> ${"•".repeat(count)}${this.focused ? CURSOR_MARKER : ""} `, width),
      truncateToWidth("Enter connects · Esc cancels · input stays private", width),
    ];
  }
}
const methodNames: Record<AuthMethod, string> = {
  "mcp-oauth": "MCP OAuth",
  "user-oauth": "Own-app user OAuth",
  "app-oauth": "Own-app app OAuth",
  "api-key": "Personal API key",
  "oauth-token": "Existing OAuth token",
};
const loginHelp: Record<string, string> = {
  login:
    "MCP OAuth signs in to Linear's MCP service as you. No OAuth app setup is needed. Native API and private files may be unavailable even with read/write access.",
  user: "Own-app user OAuth acts as you. Set LINEAR_AXI_OAUTH_CLIENT_ID and configure the callback in your Linear app (see docs/installation.md). Native API access follows the grant and your Linear permissions.",
  app: "App OAuth acts as the installed app, not as you. Reuse an existing local app token or install a new app using your public OAuth client ID and configured callback. Permissions and available paths depend on the app grant.",
  key: "Create a personal API key in Linear settings. It acts as its owner with the permissions assigned in Linear and is not refreshed automatically. Enter it only in the private masked prompt.",
  token:
    "An imported OAuth token keeps its existing actor and permissions. Unknown actor/scopes remain unknown, and no refresh token is imported. Enter it only in the private masked prompt.",
};
function formatStatus(value: AuthStatus): string {
  if (value.state === "signed-out")
    return "Linear: no connection is selected in this chat. Use /linear switch or add a connection.";
  if (value.state === "legacy")
    return "Linear: existing operator configuration. MCP and native API may use different identities. Add a saved connection to select one explicit identity.";
  const heading = value.name
    ? `Linear connection: ${value.name}${value.connectionId === value.defaultConnectionId ? " [default]" : ""}`
    : "Linear connection";
  if (value.state === "expired")
    return `${heading}: authorization expired. Renew this connection or select another saved connection; no automatic fallback.`;
  if (value.state === "error")
    return `${heading}: identity could not be verified. No other connection was selected.`;
  if (!value.identity)
    return `${heading}: no verified identity was returned. Check status before continuing.`;
  const identity = value.identity;
  const capabilities = value.capabilities;
  return [
    value.name ? heading : undefined,
    `Linear: ${identity.name}${identity.email ? ` (${identity.email})` : ""}`,
    `Workspace: ${identity.workspace.name} (${identity.workspace.slug}) · ${value.actor ?? "unknown actor"} · ${value.method ? methodNames[value.method] : (value.credentialType ?? "unknown credential")}`,
    value.scopes?.length
      ? `Granted scopes: ${value.scopes.join(", ")}`
      : "Scope information is unavailable for this credential.",
    capabilities
      ? `Available paths: ${[capabilities.mcp && "MCP", capabilities.native && "native API", capabilities.storage && "files"].filter(Boolean).join(", ") || "none"}. Refresh: ${capabilities.refresh ? "available" : "unavailable"}. Revoke: ${capabilities.revoke ? "available" : "unavailable"}.`
      : "Capabilities have not been verified.",
  ]
    .filter(Boolean)
    .join("\n");
}
function connectionLabel(
  value: AuthConnection,
  selected?: string,
  defaultId?: string | null,
): string {
  return `${value.name}${value.connectionId === selected ? " [active]" : ""}${value.connectionId === defaultId ? " [default]" : ""} · ${methodNames[value.method]} · ${value.identity?.workspace.slug ?? "unknown workspace"} · ${value.state} (${value.connectionId.slice(0, 8)})`;
}
function formatConnections(status: AuthStatus, selected?: string): string {
  const rows = status.connections ?? [];
  return rows.length
    ? [
        "Saved Linear connections:",
        ...rows.map(
          (row) =>
            `${connectionLabel(row, selected, status.defaultConnectionId)}\n  ${row.identity?.name ?? "Unknown identity"} · ${row.actor ?? "unknown actor"} · paths: ${[row.capabilities?.mcp && "MCP", row.capabilities?.native && "native API", row.capabilities?.storage && "files"].filter(Boolean).join(", ") || "none"} · scopes: ${row.scopes?.join(", ") || "unknown"}`,
        ),
      ].join("\n")
    : "No saved Linear connections. Add one with /linear.";
}
const explanations: Record<string, string> = {
  LINEAR_AUTH_STORE_FULL:
    "The saved connection store is full. Remove unused saved connections before adding another; existing connections were kept.",
  LINEAR_AUTH_NAME_EXISTS:
    "A saved connection or pending sign-in already uses that name. Choose a different name, or finish/cancel the pending sign-in.",
  LINEAR_OAUTH_CLIENT_NOT_CONFIGURED:
    "Own-app OAuth needs your application's public client ID. MCP OAuth needs no app setup; a personal API key is another option. Never paste a client secret here.",
  LINEAR_AUTH_CANCELLED:
    "Linear sign-in was cancelled. Existing saved connections remain available.",
  LINEAR_AUTH_REVOKE_UNKNOWN:
    "Linear may have revoked this grant, but confirmation was lost. Inspect its access in Linear; do not retry revocation blindly.",
  LINEAR_AUTH_REVOKE_UNSUPPORTED:
    "This credential cannot be revoked through OAuth here. Manage its access in Linear's account settings.",
  LINEAR_AUTH_COMMAND_FAILED: "The authorization command failed. Check status before retrying.",
  LINEAR_AUTH_INVALID_RESPONSE:
    "The authorization backend returned an incompatible response. Check its build/version and connection status before retrying.",
  LINEAR_AUTH_REQUIRED:
    "No usable connection is selected. Use /linear switch or add a saved connection.",
  LINEAR_AUTH_SELECTION_REQUIRED:
    "Select a saved connection with /linear switch. A default can be assigned for new chats.",
  LINEAR_AUTH_CONNECTION_REMOVED:
    "This chat's saved connection was removed. Select another with /linear switch; no automatic fallback.",
  LINEAR_AUTH_CONTEXT_CHANGED:
    "The selected Linear connection changed during this request. It was not replayed with another identity.",
  LINEAR_AUTH_CALLBACK_BUSY:
    "The sign-in callback port is already in use. Finish or close the other browser sign-in before trying again.",
  LINEAR_AUTH_CALLBACK_TIMEOUT:
    "Browser sign-in timed out. Existing connections remain available; start a new login when ready.",
  LINEAR_AUTH_APP_TOKEN_UNAVAILABLE:
    "No usable installed-App token is stored locally. Use /linear token to import an existing App token through the private prompt. Do not revoke the installation or use browser sign-in to reconnect it.",
  LINEAR_AUTH_APP_REQUIRED:
    "The existing token does not identify an App. No App connection was saved, and the selected connection was kept.",
  LINEAR_AUTH_IDENTITY_UNAVAILABLE:
    "Could not reach Linear to verify this connection. No new connection was saved. Check network access to api.linear.app; changing the key or revoking the app will not fix a network failure.",
  LINEAR_AUTH_IDENTITY_TIMEOUT:
    "The request to verify this connection timed out. No new connection was saved. Check network access to api.linear.app before retrying.",
  LINEAR_AUTH_IDENTITY_CONNECTION_FAILED:
    "The network connection to api.linear.app failed during verification. No new connection was saved. Check DNS, proxy and firewall access before retrying.",
  LINEAR_AUTH_ENDPOINT_INVALID:
    "The configured Linear API address is invalid. Check LINEAR_AXI_GRAPHQL_URL; no credential was sent.",
  LINEAR_AUTH_INVALID_CREDENTIAL:
    "Linear rejected this credential. Check it or add another connection; existing saved connections remain available.",
  LINEAR_AUTH_NATIVE_UNAVAILABLE:
    "This connection cannot use Linear's native API. Use /linear switch to select a suitable connection, or add an API key/own-app OAuth connection.",
  LINEAR_AUTH_STORAGE_UNAVAILABLE:
    "This connection cannot access private files. Select a suitable saved connection or add one explicitly.",
  LINEAR_AUTH_BUSY:
    "Another authorization operation holds the local store lock. Let it finish before trying again.",
};
const actions = [
  "Status for this chat",
  "Switch saved connection",
  "List saved connections",
  "Add MCP OAuth connection",
  "Add own-app user OAuth connection",
  "Add App connection",
  "Add personal API key",
  "Add existing OAuth token",
  "Rename a saved connection",
  "Set default for new chats",
  "Remove a saved connection",
  "Log out: remove this saved connection",
  "Revoke OAuth access in Linear",
] as const;
const actionNames = [
  "status",
  "switch",
  "list",
  "login",
  "user",
  "app",
  "key",
  "token",
  "rename",
  "default",
  "remove",
  "logout",
  "revoke",
] as const;
type Busy = (
  context: ExtensionCommandContext,
  label: string,
  work: (signal?: AbortSignal) => Promise<AuthStatus>,
) => Promise<AuthStatus>;
const direct: Busy = (context, _label, work) => work(context.signal);
type AuthDialogResult =
  | { status: "success"; value: AuthStatus }
  | { status: "failed"; error: Error };

/** Keep the dialog open until the runner has settled, including after a user abort. */
async function finishAuthDialog(
  work: Promise<AuthStatus>,
  complete: (result: AuthDialogResult) => void,
): Promise<void> {
  let result: AuthDialogResult;
  try {
    result = { status: "success", value: await work };
  } catch (error) {
    result = {
      status: "failed",
      error: error instanceof Error ? error : new Error("LINEAR_AUTH_COMMAND_FAILED"),
    };
  }
  complete(result);
}

function authDialogStatus(result: AuthDialogResult | undefined): AuthStatus {
  if (!result) throw new Error("LINEAR_AUTH_CANCELLED");
  if (result.status === "failed") throw result.error;
  return result.value;
}

const busy: Busy = async (context, label, work) => {
  if (context.mode !== "tui") return work(context.signal);
  const result = await context.ui.custom<AuthDialogResult | undefined>(
    (tui, theme, _keys, done) => {
      const loader = new BorderedLoader(tui, theme, label);
      const signal = context.signal
        ? AbortSignal.any([context.signal, loader.signal])
        : loader.signal;
      void finishAuthDialog(work(signal), done);
      return loader;
    },
  );
  return authDialogStatus(result);
};
// Reuse Pi's login screen when available. Older Pi versions retain the notification fallback.
async function browserLogin(
  context: ExtensionCommandContext,
  work: (signal: AbortSignal, onAuthorization: (url: string) => void) => Promise<AuthStatus>,
): Promise<AuthStatus> {
  const result = await context.ui.custom<AuthDialogResult | undefined>(
    (tui, _theme, _keys, done) => {
      const dialog = new Pi.LoginDialogComponent(tui, "linear", () => {}, "Linear");
      dialog.showWaiting("Preparing Linear sign-in…");
      const signal = context.signal
        ? AbortSignal.any([context.signal, dialog.signal])
        : dialog.signal;
      const operation = work(signal, (url) => {
        dialog.showAuth(url);
        dialog.showWaiting("Waiting for authorization in your browser…");
      });
      void finishAuthDialog(operation, done);
      return dialog;
    },
  );
  return authDialogStatus(result);
}
export function createLinearAuthHandler(
  run: AuthRunner = runAuthCommand,
  changed: () => void | Promise<void> = () => {},
  execute: Busy = direct,
  report: (
    context: ExtensionCommandContext,
    message: string,
    level: "info" | "warning" | "error",
  ) => void = (context, message, level) => context.ui.notify(message, level),
  controls: {
    selection?: SessionConnectionSelection;
    openBrowser?: (url: string) => Promise<boolean>;
  } = {},
) {
  return async (args: string, context: ExtensionCommandContext): Promise<void> => {
    if (!context.hasUI)
      throw new Error(
        "Linear account commands require an interactive Pi session. Use the backend auth CLI in a terminal; provide secrets on stdin, never command arguments.",
      );
    const words = args.trim().split(/\s+/u).filter(Boolean);
    if (
      words.length > 1 ||
      (words.length === 1 && !actionNames.includes(words[0] as (typeof actionNames)[number]))
    ) {
      context.ui.notify(
        "Use /linear, or status | switch | list | login | user | app | key | token | rename | default | remove | logout | revoke. Do not put credentials in the command.",
        "error",
      );
      return;
    }
    let action: string | undefined = words[0];
    if (!action) {
      const selected = await context.ui.select("Linear connections", [...actions]);
      action = actionNames[actions.indexOf(selected as (typeof actions)[number])];
    }
    if (!action) return;
    if ((action === "key" || action === "token") && context.mode !== "tui") {
      context.ui.notify(
        "Secret entry requires the interactive terminal. Use the backend's stdin import route in a private terminal.",
        "error",
      );
      return;
    }
    const invoke = (request: readonly string[], options: AuthRunOptions = {}) =>
      run(context.cwd, request, { connectionId: controls.selection?.get(), ...options });
    let dispatched = false;
    let opening: Promise<void> | undefined;
    let input: AuthRunOptions["input"];
    try {
      if (["switch", "list", "rename", "default", "remove"].includes(action)) {
        const listing = await execute(context, "Reading saved Linear connections", (signal) =>
          invoke(["list"], { signal }),
        );
        if (action === "list") {
          report(context, formatConnections(listing, controls.selection?.get()), "info");
          return;
        }
        const profiles = listing.connections ?? [];
        const labels = profiles.map((row) =>
          connectionLabel(row, controls.selection?.get(), listing.defaultConnectionId),
        );
        const clear = "Clear default for new chats";
        if (action === "default") labels.push(clear);
        if (!labels.length) {
          report(context, "No saved Linear connections. Add one with /linear.", "info");
          return;
        }
        const picked = await context.ui.select(
          action === "switch"
            ? "Use a connection in this chat"
            : action === "rename"
              ? "Rename a connection"
              : action === "remove"
                ? "Remove a saved connection"
                : "Default for new chats",
          labels,
        );
        if (!picked) return;
        const index = labels.indexOf(picked);
        const profile = index < 0 ? undefined : profiles.at(index);
        if (action === "remove") {
          if (!profile) return;
          const target = await execute(context, "Reading the saved connection", (signal) =>
            invoke(["epoch"], { signal, connectionId: profile.connectionId }),
          );
          if (
            !(await context.ui.confirm(
              "Remove this saved Linear connection?",
              `${profile.name} · ${profile.identity?.name ?? "Unknown identity"} · ${profile.identity?.workspace.slug ?? "unknown workspace"}\n\nThis removes the saved credential for every chat that uses it. Access in Linear is NOT revoked.`,
            ))
          )
            return;
          dispatched = true;
          await execute(context, "Removing saved Linear connection", (signal) =>
            invoke(["logout"], {
              signal,
              connectionId: profile.connectionId,
              expectedEpoch: target.epoch,
            }),
          );
          if (controls.selection?.get() === profile.connectionId)
            controls.selection.select(null, context);
          report(
            context,
            `Saved connection "${profile.name}" removed locally. Other saved connections were kept.`,
            "info",
          );
          return;
        }
        let request: readonly string[];
        if (action === "default") {
          const id = picked === clear ? "none" : profile?.connectionId;
          if (id === undefined) return;
          request = ["default", "--id", id];
        } else if (action === "rename") {
          if (!profile) return;
          const name = await context.ui.input("Connection name", profile.name);
          if (name === undefined) return;
          if (!name.trim() || name.length > 120 || /[\x00-\x1f\x7f-\x9f]/u.test(name))
            throw new Error("LINEAR_AUTH_INPUT_INVALID");
          request = ["rename", "--id", profile.connectionId, "--name", name.trim()];
        } else {
          if (!profile) return;
          request = ["select", "--id", profile.connectionId];
        }
        dispatched = true;
        const status = await execute(context, "Updating Linear connection", (signal) =>
          invoke(request, { signal }),
        );
        if (action === "switch" && status.connectionId)
          controls.selection?.select(status.connectionId, context);
        report(
          context,
          action === "default"
            ? "Default updated for new chats. Existing chats keep their selection."
            : action === "rename"
              ? "Saved connection renamed."
              : formatStatus(status),
          "info",
        );
        return;
      }
      let request: readonly string[] = [action];
      if (
        action === "login" ||
        action === "user" ||
        action === "app" ||
        action === "key" ||
        action === "token"
      ) {
        context.ui.notify(loginHelp[action], "info");
        const name = await context.ui.input(
          "Name this Linear connection",
          "e.g. Work key or Personal MCP",
        );
        if (name === undefined) return;
        if (!name.trim() || name.length > 120 || /[\x00-\x1f\x7f-\x9f]/u.test(name))
          throw new Error("LINEAR_AUTH_INPUT_INVALID");
        let installedApp = false;
        if (action === "app") {
          const methods = [
            "Connect installed App (reuse existing local token)",
            "Install a new App in browser",
          ];
          const chosen = await context.ui.select("App connection", methods);
          if (!chosen) return;
          installedApp = chosen === methods[0];
        }
        if (installedApp) {
          request = ["connect-app", "--name", name.trim()];
        } else if (action === "key" || action === "token") {
          const secret = await context.ui.custom<string | undefined>(
            (tui, _theme, _keys, done) =>
              new MaskedAuthInput(
                action === "key"
                  ? "Connect a personal Linear API key"
                  : "Connect an existing OAuth access token",
                done,
                () => tui.requestRender(),
              ),
          );
          if (!secret) return;
          input = {
            type: action === "key" ? "api-key" : "oauth",
            token: secret,
            name: name.trim(),
          };
          request = ["import"];
        } else {
          const profiles = [
            { label: "Read only", scope: "read" },
            action === "app"
              ? { label: "Read and write, comments and task delegation", scope: APP_AUTH_SCOPES }
              : { label: "Read and write", scope: "read,write" },
          ];
          const access = await context.ui.select(
            "Requested Linear access",
            profiles.map((profile) => profile.label),
          );
          const profile = profiles.find((profile) => profile.label === access);
          if (!profile) return;
          request = [
            "login",
            "--actor",
            action === "app" ? "app" : "user",
            "--method",
            action === "login" ? "mcp" : "oauth",
            "--scope",
            profile.scope,
            "--name",
            name.trim(),
          ];
        }
      }
      let expectedEpoch: string | undefined;
      let confirmedId: string | undefined;
      if (action === "revoke" || action === "logout") {
        const selected = await execute(
          context,
          "Checking the selected Linear connection",
          (signal) => invoke([action === "logout" ? "epoch" : "status"], { signal }),
        );
        if (
          action === "revoke" &&
          (selected.state !== "connected" ||
            selected.credentialType !== "oauth" ||
            !selected.capabilities?.revoke)
        )
          throw new Error("LINEAR_AUTH_REVOKE_UNSUPPORTED");
        if (action === "logout" && selected.state === "signed-out") {
          report(context, "No connection is selected in this chat.", "info");
          return;
        }
        if (
          !(await context.ui.confirm(
            action === "logout"
              ? "Remove this saved Linear connection?"
              : "Revoke Linear OAuth access?",
            `${formatStatus(selected)}\n\n${
              action === "logout"
                ? "This removes the saved credential for every chat that uses it. Those chats must select another connection. Access in Linear is NOT revoked."
                : "This revokes the displayed grant in Linear. Removing a saved connection is a separate local action."
            }`,
          ))
        )
          return;
        expectedEpoch = selected.epoch;
        confirmedId = selected.connectionId;
      }
      dispatched = true;
      const fallbackAuthorization = (url: string) => {
        if (opening) return;
        context.ui.notify(
          `Opening Linear sign-in in your browser. Open this link manually if needed:\n${url}`,
          "info",
        );
        opening = (controls.openBrowser ?? openAuthorizationPage)(url).then(
          (opened) => {
            if (!opened)
              context.ui.notify(
                "Automatic browser opening could not be confirmed. Open the displayed sign-in link manually.",
                "warning",
              );
          },
          () =>
            context.ui.notify(
              "Automatic browser opening could not be confirmed. Open the displayed sign-in link manually.",
              "warning",
            ),
        );
      };
      const work = (signal: AbortSignal | undefined, onAuthorization: (url: string) => void) =>
        invoke(request, {
          signal,
          input,
          expectedEpoch,
          ...(confirmedId ? { connectionId: confirmedId } : {}),
          onAuthorization,
        });
      const status =
        request[0] === "login" &&
        context.mode === "tui" &&
        execute === busy &&
        !controls.openBrowser &&
        typeof Pi.LoginDialogComponent === "function"
          ? await browserLogin(context, work)
          : await execute(
              context,
              action === "status" ? "Checking Linear identity" : "Updating Linear connection",
              (signal) => work(signal, fallbackAuthorization),
            );
      if (action === "logout") controls.selection?.select(null, context);
      else if (action !== "status" && status.connectionId)
        controls.selection?.select(status.connectionId, context);
      report(
        context,
        action === "logout"
          ? "Saved Linear connection removed locally. No connection is active in this chat; access in Linear was not revoked."
          : formatStatus(status),
        ["connected", "signed-out", "legacy"].includes(status.state) ? "info" : "warning",
      );
    } catch (error) {
      const code =
        error instanceof Error && /^LINEAR_[A-Z0-9_]+$/u.test(error.message)
          ? error.message
          : "LINEAR_AUTH_COMMAND_FAILED";
      report(
        context,
        `${explanations[code] ?? "Linear authorization did not complete. Check status before retrying."} (${code})`,
        "error",
      );
    } finally {
      input = undefined;
      await opening;
      if (dispatched && action !== "status" && action !== "list") await changed();
    }
  };
}
export function createLinearCommandHandler(
  run: AuthRunner = runAuthCommand,
  changed: () => void | Promise<void> = () => {},
  execute: Busy = direct,
  report?: (
    context: ExtensionCommandContext,
    message: string,
    level: "info" | "warning" | "error",
  ) => void,
  controls: {
    selection?: SessionConnectionSelection;
    openBrowser?: (url: string) => Promise<boolean>;
  } = {},
) {
  const legacy = createLinearAuthHandler(run, changed, execute, report, controls);
  return async (args: string, context: ExtensionCommandContext): Promise<void> => {
    const command = args.trim();
    if (!context.hasUI || (command && command !== "logout")) return legacy(args, context);
    const main = ["Log in", "Log out", "Select account"];
    let first = command === "logout" ? main[1] : undefined;
    const login = ["OAuth", "Personal API key · your permissions; no automatic refresh"];
    const oauth = [
      "MCP · your account; native API and files may be limited",
      "Own app · your account; direct API with granted scopes",
      "App identity · acts as the installed app; app permissions apply",
    ];
    const scopes = ["Global default for new sessions", "Current session only"];
    for (;;) {
      const selected = first ?? (await context.ui.select("Linear", main));
      first = undefined;
      if (!selected) return;
      if (selected === main[0]) {
        const method = await context.ui.select("Log in to Linear", login);
        if (!method) continue;
        if (method === login[1]) await legacy("key", context);
        else if (method === login[0]) {
          const choice = await context.ui.select("OAuth method", oauth);
          const index = oauth.indexOf(choice ?? "");
          const method = index < 0 ? undefined : ["login", "user", "app"].at(index);
          if (method !== undefined) await legacy(method, context);
        }
      } else if (selected === main[2]) {
        const scope = await context.ui.select("Select account for", scopes);
        if (scope === scopes[0]) await legacy("default", context);
        else if (scope === scopes[1]) await legacy("switch", context);
      } else if (selected === main[1]) {
        const say =
          report ??
          ((ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error") =>
            ctx.ui.notify(message, level));
        let attempted = false;
        try {
          const listing = await execute(context, "Reading saved Linear connections", (signal) =>
            run(context.cwd, ["list"], { signal }),
          );
          const profiles = listing.connections ?? [];
          if (!profiles.length) {
            say(context, "No saved Linear connections.", "info");
            continue;
          }
          const labels = profiles.map((row) =>
            connectionLabel(row, controls.selection?.get(), listing.defaultConnectionId),
          );
          const picked = await context.ui.select("Log out of a Linear connection", labels);
          const index = labels.indexOf(picked ?? "");
          const profile = index < 0 ? undefined : profiles.at(index);
          if (!profile) continue;
          const guardedRun: AuthRunner = (cwd, request, options) =>
            execute(
              context,
              request[0] === "revoke"
                ? "Revoking Linear access"
                : request[0] === "logout"
                  ? "Forgetting Linear connection"
                  : "Checking Linear connection",
              (signal) => run(cwd, request, { ...options, signal }),
            );
          const result = await logoutConnection({
            cwd: context.cwd,
            connectionId: profile.connectionId,
            run: guardedRun,
            confirm: (status) =>
              context.ui.confirm(
                "Log out of this connection?",
                `${formatStatus(status)}\n\nThis forgets the credential for every session using it and attempts remote revocation where supported.`,
              ),
          });
          if (result.local === "cancelled") continue;
          attempted = true;
          if (result.local === "removed" && controls.selection?.get() === profile.connectionId)
            controls.selection.select(null, context);
          const local =
            result.local === "removed"
              ? "The saved connection was forgotten locally."
              : result.local === "changed"
                ? "The connection changed during logout and was not removed; check it before trying again."
                : "Local removal could not be confirmed; check the connection before trying again.";
          const remote =
            result.remote === "revoked"
              ? "Linear access was revoked."
              : result.remote === "unsupported"
                ? "Remote revocation is unavailable; revoke access manually in Linear if needed."
                : result.remote === "unknown"
                  ? "Remote revocation is uncertain; check and revoke access manually in Linear if needed."
                  : result.remote === "refused"
                    ? "Linear refused revocation; revoke access manually in Linear."
                    : "Remote revocation failed; check and revoke access manually in Linear if needed.";
          say(
            context,
            `${local} ${remote}${result.errorCode ? ` (${result.errorCode})` : ""}`,
            result.local === "removed" && result.remote === "revoked" ? "info" : "warning",
          );
        } catch (error) {
          const code =
            error instanceof Error && /^LINEAR_[A-Z0-9_]+$/u.test(error.message)
              ? error.message
              : "LINEAR_AUTH_COMMAND_FAILED";
          say(
            context,
            `Logout did not complete. Check the connection before retrying. (${code})`,
            "error",
          );
        } finally {
          if (attempted) await changed();
        }
      }
    }
  };
}
export function registerLinearAuthCommand(
  pi: ExtensionAPI,
  changed: () => void | Promise<void>,
  selection?: SessionConnectionSelection,
) {
  pi.registerMessageRenderer<{ level?: string }>(
    "linear-auth",
    (message, _options, theme) =>
      new Text(
        theme.fg(
          message.details?.level === "error" ? "error" : "text",
          typeof message.content === "string" ? message.content : "Linear account result",
        ),
        0,
        0,
      ),
  );
  pi.registerCommand("linear", {
    description: "Log in, log out, or choose a Linear account.",
    handler: createLinearCommandHandler(
      runAuthCommand,
      changed,
      busy,
      (_context, message, level) => {
        pi.sendMessage({
          customType: "linear-auth",
          content: message,
          display: true,
          details: { level },
        });
      },
      { selection },
    ),
  });
}
