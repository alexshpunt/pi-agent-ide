# GitHub identity, access and recovery

Use `/github status` to check the selected profile's verified user or bot. Users connect their own App through device authorization, their own App installation through a private-key file, or a PAT through hidden input. There is no shared publisher App or server. Read [setup](docs:github-setup) for connection and storage instructions. Never read key/credential files into tool results or ask for tokens in chat; secret entry belongs in the terminal UI or an external private provisioning step. Existing PiClanker settings are a compatibility source, not a requirement; its shell routing is unchanged.

Use `/github` to add a connection, select an account or log out. Adding a connection does not change the current identity. A session selection takes precedence. Existing project defaults take precedence until a global default is explicitly selected; that choice then takes precedence across projects. Sessions pin their default on first use; changing a default does not retarget another running session. After switching, get fresh Read/Search context; old selections, response snapshots and scoped permits cannot authorize writes as the new profile. Missing or revoked credentials fail rather than falling through to another account.

Logout removes the selected local connection after confirmation. A PAT or App user authorization needs manual revocation on GitHub; the extension does not store the App client secret needed for the user-token deletion API. Logout can revoke an already cached installation token in the current process, but other sessions may hold their own tokens. The App installation and external private key remain. Report local and remote outcomes separately, including an uncertain remote outcome. Do not retry an uncertain revocation automatically. See [setup](docs:github-setup) for manual revocation links.

The selected token's permissions and repository access bound every operation. App user tokens require access granted to both the user and their App. A working read does not prove write or review permission. Do not change scopes, keys, repository rules or the selected account automatically.

## Bash fallback

If native resource tools cannot complete part of an operation, use Bash only with an explicitly authorized identity for that work. Verify it before making remote changes: native profile selection does not change git/gh authentication or shell routing. Do not silently enable another saved account. Report permission denial rather than changing identity or scopes to bypass it. Inspect unknown effects before changing tools; do not repeat an uncertain mutation through Bash. Ask before destructive work and verify the affected resource afterward.

## Request safety

Requests, response bytes and pages are bounded and cancellable. Linked bodies stay lazy. Rate limits, inaccessible resources, unsupported routes and incomplete pages are different outcomes. Do not turn an error into empty results.

Pre-save revision/content checks reject detected conflicts; they are not atomic compare-and-swap. After mutation, Read again. Unknown creation/update/upload effects can already have changed GitHub: inspect the exact target and keep any returned identity before deciding whether a retry is safe.

Credentials go only to the trusted GitHub API/upload host. Signed CDN downloads do not receive the bearer credential. Sensitive response messages and signed URLs are not copied into tool results or artifacts.

## Rate limits

A confirmed cooldown returns `GH_RATE_LIMITED` without another HTTP request. Do not poll, probe quota or retry automatically before its deadline. Do not switch accounts to bypass a limit.

Limits are coordinated by verified upstream user or App installation, not by saved profile or token. Equivalent credentials share their owner's cooldown; unrelated owners remain independent. Processes using the same quota-state directory share confirmed cooldowns. API requests and release uploads share the API quota; unrelated CDN origins remain separate.

Read failures expose permitted timing in `errors[].metadata.rateLimit`: `retryAfterMs` is milliseconds and `resetAt` is a Unix timestamp in milliseconds. The full absolute deadline remains authoritative even when the relative delay is capped. Other permitted fields describe the request limit, remaining requests and quota bucket. Model text and the terminal also show available retry timing; private headers and upstream messages are not exposed. In Codemode, a failed Read returns `null`; the script result lists the error and available timing. Pi-level rejections can still throw.

A successful response that exhausts the quota remains successful; later sends are blocked until the deadline. Healthy sends are serialized and mutations are paced. Queued work is bounded and cancellable. A cooldown does not change token permissions, authorize a retry or prove that an earlier mutation was not applied. Inspect an unknown effect before any retry.

## Confirmations by mode

With Pi Agent IDE enabled, typed high-risk actions use its shared approval policy. Without a configured or remembered grant, the dialog offers Deny, Allow once and Allow for session; unavailable UI, cancellation, refusal or dialog failure grants no permission. Herdr shows waiting only while a terminal dialog is open. Each dispatch still consumes its exact-target permit.

Use /agent-ide-settings to change GitHub YOLO (pi-agent-github-yolo) in Global or Project scope. IDE mode defaults to YOLO off. On skips existing typed confirmations, Off overrides common YOLO, and Default inherits pi-agent-ide-yolo. Allow for session remembers the same connection owner and dialog category across targets, /reload and reopening that saved session; it does not carry to a new session or another connection profile. Remembered grants are separate from persistent YOLO settings. Read docs:ide-settings before editing saved configuration.

Without the IDE extension enabled, standalone GitHub is always YOLO. It skips typed confirmations even without UI, and ignores IDE YOLO settings. There is no standalone confirmation toggle. Only enable this mode for agents you trust with the selected connection's access.

Both modes keep payload validation, known-head and stale-target checks, cancellation and token permission limits. Skipping a dialog does not authorize an operation outside the user's request.

Raw REST/GraphQL Write has no per-request confirmation in either mode, including headless changes and DELETE. It can bypass typed routes and is not controlled by GitHub YOLO. Ask the user before destructive work; a broad request to work on a repository does not authorize every destructive operation. Read [Open API](docs:github-api) for this distinction.
