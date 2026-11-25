# Connect your GitHub accounts

Each user supplies their own GitHub App or personal access token. There is no shared publisher App or authorization server. Native operations do not need PiClanker or `gh` installed.

Credential storage requires owner-only permissions on POSIX or a private NTFS access control list on Windows. If the extension cannot verify protection, it refuses to use the store.

## Add a connection

Reload Pi after installing the extension, then open:

```text
/github
```

Choose **Log in**. Three methods are available:

| Method                     | What you provide                                        | Who performs GitHub actions     |
| -------------------------- | ------------------------------------------------------- | ------------------------------- |
| GitHub user through my App | Your App's Client ID, with device flow enabled          | The user who approves the login |
| My App installation bot    | Your App ID, private-key file and selected installation | Your App's bot                  |
| Personal access token      | Your PAT, entered in a hidden terminal prompt           | The token's user                |

Adding a connection only saves it. It never replaces another profile, switches the current session or sets a default, even for the first connection. Use **Select account** in `/github` to select it explicitly. The account list marks the active and default connections. `/github status` checks the actual user or bot without printing credentials.

### Sign in as a user through your App

[Register your own GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), or use one you already own. Enable device flow in its settings. Install the App on the accounts and repositories it needs to access.

Select **GitHub user through my App** and enter that App's **Client ID**, not its numeric App ID. Pi shows a GitHub URL and a short code. Open the URL in your browser, enter the code and approve access with the intended GitHub account. The browser can be on another machine when Pi runs over SSH. Esc cancels the waiting screen.

This flow uses no client secret or private key. Expiring access and refresh tokens are renewed locally. GitHub limits access to permissions and repositories available to both the user and the App. Authorizing a user does not grant an uninstalled App access to private repositories.

Actions belong to the signed-in user. GitHub does not let PR authors approve their own PRs. Use a bot connection when the agent must open a PR that you will review from your personal account.

### Connect your App's bot

Install your own App on the intended account and repositories. Grant the permissions needed for your work; requirements vary by endpoint. The extension never expands permissions or changes installations for you.

Keep its RSA private key outside every repository, in an owner-only regular file. On a POSIX host, protect your actual key path:

```bash
chmod 600 /path/to/your-app.pem
```

On Windows, the key and connection store must have private NTFS permissions. The extension checks access rights on the file and its parent directories. It refuses files that other users can read and paths they can replace. Keep the key in your Windows user profile with access limited to your account, administrators and system services.

Choose **My App installation bot**. Enter the numeric **App ID** and the absolute key-file path. Do not paste the PEM contents. Select an active installation from the list; use **Next page** if needed. Pi verifies the App's bot before saving the connection. Short-lived installation tokens stay in memory and renew when needed.

### Connect with a PAT

Create a token with access to the repositories and operations you intend to use. Organization policy and GitHub's token-type limitations still apply.

Choose **Personal access token**. Enter it only in the masked terminal prompt, never in chat, command arguments or project settings. Pi verifies the user before saving it. Expired or revoked PATs must be replaced; they cannot be renewed like OAuth tokens.

## Select a profile

Choose **Select account** in `/github` to switch this session or set the global default for new sessions. A session selection takes precedence. Existing project defaults remain in place until you explicitly choose a global default; that choice then takes precedence across projects. Changing a default does not change the current session or other running sessions, which pin their defaults on first use. Reopening a saved session restores its session selection. If the selected global default is removed or cleared, existing project defaults apply again.

The same actions are available by profile ID:

```text
/github list
/github switch PROFILE_ID
/github global PROFILE_ID
/github default PROFILE_ID
/github reset
```

`global` sets the global default; `default` sets this project's default. Omit the ID to choose a saved connection interactively. `use` remains an alias for `switch`.

Save multiple user accounts or bots independently. Two connections for the same GitHub login can have different permissions; choose the connection, not just the login name. Native GitHub tools use only that connection's permissions. Switching does not change authentication for shell commands such as `git` or `gh`.

A removed or revoked profile fails explicitly; the extension does not try another account. After switching, repeat Read/Search before editing. Old selections, API response snapshots and scoped action permits cannot be reused under the new profile. A change already sent to GitHub may still have applied if cancellation loses its response; inspect it before retrying.

## Log out

Choose **Log out** in `/github` and select a connection, or run `/github logout PROFILE_ID`. Confirm before removing the selected local profile and its saved credentials. Other connections remain. Removing an inactive connection leaves the active one untouched; removing the active connection blocks access until an explicit selection.

Logout reports local removal and remote revocation separately. For a PAT, revoke it in GitHub's [personal access token settings](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens). For an App user connection, revoke the [GitHub App authorization](https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps). Revoking an App authorization can affect other tokens for that user and App. The extension does not store the App client secret required by GitHub's user-token deletion API.

For an installation bot, logout can revoke an already cached installation token in this Pi process. Other sessions may hold separate tokens. Logout does not uninstall the App, revoke the App's ability to mint tokens, or delete the external private-key file. Inspect an uncertain remote outcome before retrying.

## Local storage and non-interactive use

Profiles and project defaults live in `~/.config/pi-agent-github/profiles.json`; the global default lives in `global-default.json`, its precedence marker in `global-preference.json`, and tokens live separately in `credentials.json`. The store also uses `epochs.json` to protect logout against concurrent replacements. On POSIX these paths must belong to the Pi user; keep the directory at mode `700` and the files at mode `600`. On Windows, use a private NTFS directory as described for App keys. The directory must be writable for locking and token refresh. Symlinks and hard-linked credential files are refused.

Tokens are plaintext on disk, not encrypted by the extension. This uses the same protection baseline as Pi's `auth.json`: owner-only local files rather than encryption at rest. Saves and token refreshes are locked across processes; GitHub credential writes use atomic replacement. App keys remain external, owner-only, single-link regular RSA PEM files; pipes and symlinks are refused and key reads are bounded. Never commit or share the storage directory or key files. Authentication UI and normal logs do not print secret values; this does not isolate them from code running as the same OS user.

To select another protected directory before starting Pi, set `PI_GITHUB_CONFIG_DIR` to an absolute path outside repositories. An empty or relative override is refused. Do not put tokens in this variable.

Saved connections work without UI. Create them in interactive Pi first, or provision the two protected files through your deployment's secret-file mechanism. For example, a PAT connection uses this non-secret metadata:

```json
{
  "version": 1,
  "profiles": [{ "id": "ci", "label": "CI", "kind": "pat" }],
  "projectDefaults": { "/absolute/checkout/path": "ci" }
}
```

Its separate `credentials.json` has this shape; replace the placeholder privately, without echoing the token into logs:

```json
{
  "version": 1,
  "secrets": { "ci": { "kind": "pat", "token": "REPLACE_WITH_YOUR_PAT" } }
}
```

The project path must match the absolute directory used by Pi. Do not write these files while another process is refreshing credentials. The extension serializes its own saves and refreshes across processes.

## Existing PiClanker settings

A valid existing `~/.config/pi-clanker/config.json` can be imported as an App connection when a project first needs authentication. `PI_CLANKER_CONFIG` still selects a different trusted legacy file; relative values resolve from Pi's working directory. The extension does not rewrite that file, its key or PiClanker's shell routing.

The legacy file contains only `appId`, `installationId` and an absolute `privateKeyPath`. Existing ownership, regular-file and permission checks still apply. Removing an imported connection does not automatically recreate it when the project is reopened. Add it again explicitly if you want to reconnect.

## Tool modes and failures

Mode selection is automatic. With Pi Agent IDE enabled, use ordinary resource tools. Without it, discover `github_*` through `tool_search`. Standalone uses the IDE SDK as a library without enabling the IDE extension.

Read `docs:github` through the selected Read tool. IDE mode keeps its approval policy and **GitHub YOLO** setting. Standalone is always YOLO, including typed actions without UI; IDE YOLO overrides do not apply there. Raw REST/GraphQL writes are ungated in both modes.

Authorization errors distinguish unreachable GitHub or timeouts, rejected credentials (401), denied access (403), rate limiting (429), disabled device flow, and unsafe or inaccessible local storage. Fix the named cause: network failures do not require a new account; disabled device flow requires enabling it in your own App. Use the Client ID for user sign-in and the numeric App ID for bot sign-in. A successful identity check does not prove access to every endpoint. Do not switch accounts to bypass a permission denial. Read [access and recovery](github-access.md) before destructive work or retrying an uncertain effect.
