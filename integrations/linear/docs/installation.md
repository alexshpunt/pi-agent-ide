# Installation and authentication

## Requirements

Use Node.js 24 or newer and Pi. The `pi-agent-ide` package supplies the SDK used by Linear in both modes. Its installed SDK and its loaded extension are separate things:

- Load Pi Agent IDE for the ordinary `read`, `search` and editing tools.
- Leave the IDE extension unloaded for the dedicated `linear_*` tools. Keep the SDK dependency installed.

A packaged install uses Pi Agent IDE SDK 1.1 or newer within the 1.x series.

## Install a supplied release tarball

The npm release is not published yet. Do not assume an `npm:pi-agent-linear` installation is available.

In a separate local directory, install the supplied `.tgz` with its runtime dependencies:

```sh
mkdir pi-linear
cd pi-linear
npm init -y
npm install --omit=dev /absolute/path/to/pi-agent-linear.tgz
pi install ./node_modules/pi-agent-linear --local
```

Replace the tarball path with the actual file you received. Keep normal npm install lifecycle behavior; do not compensate for a broken artifact by linking the source checkout or building omitted development files in the consumer.

Pi loads local packages from their existing paths. Keep this directory in place. The `--local` option records the package in this project's `.pi/settings.json`; omit it for a personal installation. Review the project package declaration before granting trust.

## Install from the IDE checkout

Run from the Pi Agent IDE repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter pi-agent-linear run build
pi install ./integrations/linear --local
```

The build compiles the AXI backend included in the workspace. Enable the package at `integrations/linear`. You do not need a global AXI command or a separate backend checkout.

Reload Pi after changing enabled resources. Use `pi list` to check configured packages. Run `pi remove ./integrations/linear --local` from the same project to remove the Linear package entry without changing the IDE.

On Linux or in WSL, build a local tarball by running `pnpm --filter pi-agent-linear run package:public` from the repository root. The command prints its path and SHA-256. Use `pnpm --filter pi-agent-linear run check:package` to pack it, install the archive in a fresh consumer, and check the installed plugin with Pi.

## Enable IDE integration

Install and enable Pi Agent IDE separately if you want its ordinary resource tools:

```sh
pi install npm:pi-agent-ide
```

If it is already installed, check its enabled resources rather than adding a duplicate package entry. Linear uses the IDE plugin APIs in either extension load order and does not register the general standalone tools when that integration is active. `linear_upload` and `/linear` remain available.

To use standalone mode, leave the IDE extension disabled in your Pi resource configuration. Do not remove the installed SDK dependency. Pi's [package resource filters](https://pi.dev/docs/latest/packages) can disable a package's extensions independently of its installation.

## Authorize Linear

In interactive Pi, run:

```text
/linear
```

Choose **Log in** to add a named connection, then **Select account** to choose a saved connection for this session or the default for new sessions. You can save several keys for the same user, different accounts and different login methods without logging out first. A successful addition becomes active in this chat; a failed or cancelled addition leaves the previous selection intact.

### Choose a login method

| Login choice         | What it authorizes                   | Setup and limits                                                                                                                                                           |
| -------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth → MCP          | MCP OAuth as your Linear user        | Uses Linear's MCP OAuth discovery, dynamic client registration and PKCE. No own-app setup is needed. Read/write scopes do not guarantee native API or private-file access. |
| OAuth → Own app      | Your user through your own OAuth app | Requires the public client ID and callback configuration below. Changes act as you and remain subject to the grant and your Linear permissions.                            |
| OAuth → App identity | Your installed App as the actor      | Reuses an existing local App token after verifying its identity. New installations use browser OAuth with your public client ID.                                           |
| Personal API key     | The owner of a personal API key      | Uses the key's existing permissions. Enter it in the masked prompt. API keys are not refreshed automatically.                                                              |

For an already installed App, choose **Connect installed App**. AXI verifies the existing local App token and saves a named connection without opening a browser, exchanging tokens or changing grants. It retains the token's expiry; unreported scopes remain unknown. The local cache is unchanged, and the connection is selected only in this chat. Your default stays unchanged. If no usable cached token exists, import an existing App access token with `/linear token` through the private prompt. Do not revoke or reinstall the App to connect it.

Choose **Install a new App in browser** only for a new installation in that workspace. Linear's **already installed** page does not complete the callback flow.

Browser sign-in opens the validated consent URL in your ordinary browser and also displays a link for manual completion. Choose read-only or read-and-write access when prompted. For App OAuth, the write profile also requests `comments:create` and `app:assignable` for comments and task delegation. User and MCP OAuth keep their read/write scopes. If opening is unavailable, open the displayed link yourself. The consent URL is not sent to the model.

Check the permissions on Linear’s consent screen before approving. If an installed app shows permissions to remove, cancel instead of revoking its token. Adding a local connection must not remove permissions another session needs.

`login` always chooses MCP OAuth, even when own-app configuration exists. Use `user` or `app` to choose that app explicitly. Status reports the connection's verified identity, workspace, login method, known scopes and actual MCP/native API/file capabilities. Unknown scope information remains unknown. A successful login does not promise permission to every resource or operation; an unavailable path is refused without using another saved connection.

If API-key verification times out or cannot connect, check network access from the machine running Pi to `api.linear.app`. No new connection is saved on a failed check. Changing a key or revoking an app does not repair DNS, proxy or firewall failures.

Do not put credentials or callback URLs in chat, command arguments, Tasks, repository files or shell history. Key/token entry requires the interactive terminal; trusted private CLI callers can use stdin.

### Switch, name and set a default

- `/linear list` shows saved connections with active/default markers, identity, method, workspace and capability limits.
- `/linear switch` selects a saved connection for the current Pi session only.
- `/linear rename` changes a saved connection's name. Names must be non-empty, at most 120 characters and unique ignoring case.
- `/linear remove` removes any saved connection by name after confirmation, including a rejected or expired credential, without switching this chat away from a different working connection.
- `/linear default` assigns or clears the connection used by new chats.
- `/linear status` verifies the selected connection and reports its current capabilities.

Saved connections are shared within the local Pi agent directory. Each session stores only its connection reference and restores that selection after reload or resume. A new session snapshots the explicitly assigned default; later default changes and switches in other chats do not change its selection. If there is no default, select or add a connection explicitly. Adding a connection does not automatically make it the default.

Switching invalidates old read selections and approvals in that chat. Read again before editing as the selected identity. An in-flight operation is never silently rerouted or replayed under another principal.

### Optional own-app OAuth

Set `LINEAR_AXI_OAUTH_CLIENT_ID` to your app's public client ID, or save public metadata in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/config/linear-axi/oauth-client.json`:

```json
{
  "clientId": "your-public-client-id",
  "redirectUri": "http://127.0.0.1:14566/oauth/callback"
}
```

Allow that exact callback URI in your app's settings. `LINEAR_AXI_OAUTH_CONFIG_FILE` selects another metadata file; `LINEAR_AXI_OAUTH_REDIRECT_URI` overrides the callback. Keep configuration outside the repository. The PKCE flow does not require a client secret; never add one to this file or send one to Pi.

Use `/linear user` for user-actor authorization or `/linear app` for app-actor authorization. To add an MCP connection, use `/linear login`; you do not need to clear the app configuration. Saved OAuth connections retain the client information needed for their own refresh.

### Logout, revocation and renewal

Choose **Log out** and select a saved connection. After confirmation, Pi forgets it locally and attempts remote revocation for supported OAuth grants. The credential is removed for every session using it, and its default is cleared. Those sessions must select another connection; no account or operator cache is used as a fallback.

The result distinguishes successful revocation from unsupported, refused, failed or uncertain outcomes. Manage API keys and unsupported grants in Linear's settings. If the remote result is uncertain, inspect access in Linear and revoke it there if needed. If the connection changed concurrently or local removal failed, check the saved connection before retrying.

Revocation retires the selected local grant before contacting Linear. After dispatch, timeout or cancellation leaves it retired and reports an unknown remote outcome. A definite refusal can restore only the same unchanged grant; it never replaces another connection.

Browser OAuth grants can refresh when Linear supplies a refresh token. Imported access tokens and API keys have no automatic renewal; add a replacement when they expire or are rejected. Installed App connections can opt into client-credentials renewal below. You can switch to another saved connection while arranging renewal. Other saved connections are retained.

### Installed App token renewal

Linear's [client-credentials App tokens](https://linear.app/developers/oauth-2-0-authentication) have no refresh token. AXI can request a replacement for an existing installed-App connection without reinstalling it. Enable this only after the operator confirms the original client ID and exact scope set: requesting different scopes can revoke other App tokens. The old token cache records neither value, and an empty status scope list means unknown, not an empty grant.

Keep `LINEAR_AXI_CLIENT_ID` and `LINEAR_AXI_CLIENT_SECRET` in the existing private environment configuration. Their legacy aliases are `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`. Configure the exact original scopes through `LINEAR_AXI_TOKEN_SCOPE` or the operator App scope file `${PI_CODING_AGENT_DIR:-~/.pi/agent}/config/linear-axi/app-scope.json` (override with `LINEAR_AXI_APP_SCOPE_FILE`). Renewal requires explicit scopes; it never uses the legacy default. Do not put the secret in command arguments or public OAuth metadata.

Replace both placeholders and run against the intended saved connection:

```sh
LINEAR_AXI_CONNECTION_ID=<connection-UUID> linear-axi auth enable-app-renewal --scope '<original-comma-separated-scopes>' --json
```

This operation is local-only. It requires an installed-App connection whose token matches the existing operator cache, pins the configured client ID and the declared scope set, and reports refresh availability. It does not exchange tokens, verify access remotely, infer granted scopes, change the default or selection, or replace the current token. Repeating it with the same binding is safe. It refuses API keys, user/MCP grants and browser grants with their own refresh credentials.

During a later authorized operation, a token within 30 seconds of expiry is replaced under the connection's lock. Renewal reads the secret from the private environment configuration and refuses a changed client ID or scope set before sending HTTP. It requests the pinned scopes, verifies the same App actor and workspace, and atomically saves the replacement without changing the connection ID or authorization epoch. The legacy token cache stays unchanged.

A rejected exchange, malformed response or identity/scope mismatch leaves the saved grant unchanged. There is no fallback connection, scope expansion or mutation replay. Repair the configuration or authorization before trying again. `auth status --json` can renew and verify remotely; use `auth list --json` for a local-only capability check.

### Local credential storage and migration

AXI uses private local JSON files under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/config/linear-axi/`. The default base path is `connection.json`: its named-connection catalog is `connection.json.profiles.json`, and per-connection grant files are under `connection.json.connections/<UUID>.json`. `LINEAR_AXI_CONNECTION_FILE` overrides the base path. These files are separate from Pi's model-provider `auth.json`.

On Unix, credential files are created with mode `0600` and new private directories use `0700`. On Windows, the store checks NTFS access rules before reading or writing: files and their containing directories must be private to the current user, SYSTEM and administrators. Windows PowerShell must be available to inspect the access rules. Unsafe or unverifiable paths are refused. Updates use locking and atomic replacement. This follows Pi's filesystem-based credential-storage model: the JSON is not encrypted and is not protected from processes running as the same OS user, including Pi itself. Keep the files private and outside version control. Do not inspect, print or copy credential contents to move a login between machines.

An existing managed single-connection credential is migrated automatically as **Existing Linear connection** and becomes the default. The saved grant is retained without re-entry. Rename it or change the default through `/linear` after migration.

### Remote or headless use

`/linear` requires an interactive Pi session. Authenticate on the same machine and with the same agent directory as the headless run. Assign a default for new sessions or explicitly choose a saved connection; never copy credential files from another machine.

For direct CLI use, `LINEAR_AXI_CONNECTION_ID=<connection-UUID>` selects a saved connection for that process and its children; `LINEAR_AXI_CONNECTION_ID=none` selects no connection. Without that variable, the CLI resolves only the assigned default. `auth select --id <UUID> --json` returns the selected connection's safe status but does not change the default or persist a selection for later independent CLI processes.

Use these commands with the installed backend entry point, or with `linear-axi` when that executable is available. Replace `<connection-UUID>` with an ID returned by `auth list`:

```sh
linear-axi auth list --json
linear-axi auth select --id <connection-UUID> --json
linear-axi auth rename --id <connection-UUID> --name "Work key" --json
linear-axi auth default --id <connection-UUID> --json
linear-axi auth default --id none --json
```

If the browser cannot reach the callback listener, use manual completion in your own private terminal. Do not run these login steps through agent tools or copy their output into a conversation. From the directory where you installed the tarball, locate its backend and start named read-only MCP sign-in:

```sh
AXI=$(node -e 'const r=require("node:module").createRequire(require.resolve("pi-agent-linear/package.json"));console.log(r.resolve("@nikolauska/linear-axi/dist/bin.js"))')
node "$AXI" auth login --method mcp --actor user --name "Remote MCP" --scope read --manual --json
```

For own-app OAuth, use `--method oauth` with `--actor user` or `--actor app` and the configured public client ID. Open the returned authorization URL yourself. After consent, the browser may show a loopback connection error because manual mode has no listener. Copy the full callback address from its address bar. In the same private Bash terminal, use this masked prompt and stdin pipe; the callback never becomes a command argument or history entry:

```bash
set +x
IFS= read -r -s -p 'Callback URL: ' callback
printf '\n'
printf '%s' "$callback" |
  node -e 'let callbackUrl="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>callbackUrl+=s);process.stdin.on("end",()=>console.log(JSON.stringify({callbackUrl})))' |
  node "$AXI" auth finish --json
unset callback
```

The pending sign-in expires after ten minutes. After completion, use `/linear switch` in the intended Pi chat, or select the returned connection UUID through `LINEAR_AXI_CONNECTION_ID` for direct CLI calls. Assign it as the default only if new sessions should use it. If you use a backend override, run that same backend instead of resolving the packaged default.

### Existing operator configuration

Direct AXI CLI calls can retain existing operator configuration before managed storage is established. In that legacy mode, MCP and native GraphQL/private files may use different identities. Pi chats without a managed default instead keep an explicit empty selection: assigning a default later does not silently change an already-open chat.

Legacy app-token settings, including privately configured client ID/secret values, remain available for existing operator deployments. They are not required for named managed connections. Keep them outside the repository. Once managed storage is established, an unselected or removed connection does not fall back to this legacy route.

If an operation is refused, inspect its error and the selected resource's contract. Do not change credentials, add scopes or select a broader token automatically. See [access and recovery](linear-access.md).

## Optional backend override

The installed backend is the default. Set an override only when you deliberately want another executable or JavaScript entry point:

```json
{
  "axiPath": "/path/to/linear-axi/dist/bin.js"
}
```

Save it as `linear.json` in Pi's agent directory for personal use, or as `.pi/linear.json` in the project. The project value wins. Relative project paths resolve from the project root; relative personal paths resolve from the agent directory. `PI_CODING_AGENT_DIR` selects a different agent directory.

These files store the backend path only. Keep credentials out of them. Remove an obsolete override that points to a retired checkout to restore the installed-package default.

### Backend worker

When the backend is a JavaScript entry point with a `worker.js` next to it, as in the installed package, Pi keeps one long-lived worker process per backend and project directory. Ordinary commands and auth status reads run in that worker, so they don't pay the backend's module loading on every call. Each command still gets its own environment, timeout and cancellation. Sign-in, commands with secret input and backends without `worker.js`, such as a native executable, start a separate backend process for each command.

The worker stops after five idle minutes and when Pi exits. After you rebuild the backend, the next command starts a new worker. A worker that exits while a command runs fails that command with `LINEAR_AXI_FAILED`; a mutation that was already sent keeps an unknown effect and is not resent.

## If tools are missing

- If the IDE extension is loaded, use ordinary `read`, `search` and editors for Linear resources.
- In standalone mode, ask `tool_search` for Linear reading, discovery or editing. The general `linear_*` tools are deferred until discovered.
- If Pi reports an extension load error, check dependency installation and SDK compatibility first. Removing the IDE extension does not remove its SDK requirement.
- If a high-risk standalone action runs without interactive UI, it is refused. Standalone mode has no YOLO switch.
