# Linear access and recovery

Read this guide when access fails, a save is stale, an outcome is uncertain, or an operation requires approval.

## Keep authorization with AXI

AXI owns credentials and refresh. Do not inspect, copy or print secrets. The user manages named saved connections with `/linear`. Use `switch` to choose a connection for the current Pi session, `list` or `status` to inspect safe metadata, and `default` to assign the connection for new sessions. Never ask the user to paste a credential or callback URL into the conversation. See [installation and authentication](installation.md#authorize-linear) for the login methods and setup.

Saved connections are shared locally, but each session keeps its own active selection across reload and resume. Adding or switching connections does not require logout, change another session's selection or change the default. Failed or cancelled additions leave existing connections available. Without an assigned default, select a connection explicitly; never choose an arbitrary saved account.

Each operation uses the session's selected credential. Status reports its verified identity and actual capability limits. A successful MCP login, including one with read/write scopes, does not prove native API or private-file access. An unavailable path is a refusal: ask the user to select a suitable saved connection or add one explicitly. Do not retry automatically, broaden scopes or substitute another account.

`logout` removes the selected saved connection locally after confirmation. It affects every session that selected that connection and clears the default if it pointed to it. Those sessions must explicitly select another connection; no saved account, environment token or old operator cache is used as a fallback. Use `remove` to explicitly remove a different saved connection, including one that cannot pass verification; this does not switch away from the chat's working connection. Local removal does not revoke access in Linear. Use the separate `revoke` action only when the user intends remote OAuth revocation.

Switching invalidates old result handles and exact-target approvals in that session. Read again to get fresh anchors under the new connection. Do not reroute or replay an in-flight operation with another principal. Store only the connection reference in session state; credentials remain in private local files with Pi's filesystem-based protection, not encrypted or isolated from the same OS user.

Only direct CLI legacy operator mode, before managed storage is established, can use separate MCP and app authorization. Pi chats without a usable default keep an explicit empty selection. Keep legacy identities distinct instead of describing a mixed setup as one verified account.

Do not broaden scopes or switch connections automatically. Changing a client-credentials scope request can revoke existing app tokens. Scope changes and broader-token refresh need the user's approval. For legacy operator app authorization, approved scopes can be kept in the separate non-secret `${PI_CODING_AGENT_DIR:-~/.pi/agent}/config/linear-axi/app-scope.json`; explicit `LINEAR_AXI_TOKEN_SCOPE` wins. Never edit credential files to accomplish this.

The provider uses its installed AXI package by default; no separate CLI installation or PATH entry is needed. To override the backend, set `axiPath` in Pi's agent-directory `linear.json`. A project's `.pi/linear.json` takes precedence. These files store only the CLI path, not credentials. See the package README for setup.

## Request reuse and rate limits

Repeated Reads and searches can reuse tool schemas, a verified workspace check and the verified parent project or team identity for up to five minutes. These private entries are scoped to the named connection, authorization epoch and server. A different connection or epoch cannot reuse that proof. Legacy mixed-principal mode bypasses shared metadata. AXI still fetches each requested resource; it does not cache operation results.

A scalar field Read requests that field immediately when the live schema advertises a field projection. Issue reads projected to other fields do not request a missing estimate from the native API. Explicit estimate reads and complete field cards still enrich an omitted estimate when native access is available. A partial field row does not replace the complete pre-save state needed by a later edit.

AXI records a shared cooldown for a named connection after HTTP `429`, a decoded native GraphQL `RATELIMITED` response (including HTTP `400`), a structured MCP tool error with a recognized rate-limit code or status, or headers reporting an exhausted limit with a future reset. The cooldown belongs to that connection, authorization epoch and full server endpoint, including meaningful query parameters. Later CLI processes refuse HTTP to that endpoint until the deadline. Cooldowns are capped at 24 hours. A rate signal without usable timing gets a one-second local guard, not a promise that the server window has reset. AXI does not wait out the cooldown, retry a failed operation or reroute a mutation automatically.

A valid `Retry-After` determines the cooldown deadline, including responses whose rate-limit signal is decoded from the body. Linear refills its leaky bucket continuously, so this can be earlier than the full-reset timestamps. If `Retry-After` is absent or invalid, AXI uses the latest applicable reset. Successful responses that report an exhausted counter without retry timing retain the reset-based guard.

Creation timestamps up to two seconds ahead of the current wall clock are accepted for shared metadata and cooldowns. Larger future timestamps remain invalid. The stored cooldown deadline stays unchanged, and the reported remaining delay cannot exceed its original duration.

Failed mutations are not replayed for authentication recovery or redirects. In legacy OAuth mode, a mutation's `401` or `403` cannot trigger an SDK refresh, scope expansion or resend. Select or renew the intended authorization explicitly before deciding whether to issue another request.

Failures can include allowlisted retry/reset timing and quota counters. Raw headers, private response bodies and credentials are excluded. Follow the reported timing before an explicit retry. If the server supplies no usable timing, its actual reset remains unknown despite the local guard; do not loop on the error.

Read presents this timing through the IDE SDK's explicit safe error-metadata contract. An older SDK may retain only the safe failure code and generic no-retry guidance; CLI receipts still carry the bounded timing fields.

The stage in a code such as `LINEAR_WORKSPACE_RATE_LIMITED` identifies the check that failed, not the server quota. It does not prove that a workspace-specific limit fired or that one MCP call consumed one GraphQL quota unit.

Plan every loop against that shared budget. List or filter tasks with one search or filtered GraphQL query and its cursor (see [Discovery](linear-discovery.md#list-issues-by-status-label-or-priority)), never by reading identifiers one at a time: a few hundred requests exhaust the rate limit, and the cooldown, up to an hour, stops every session on the connection. Try a loop on a handful of items first, keep its concurrency low, and stop all Linear calls at the first rate-limit error until its reported reset time.

Plan parallel work against the authenticated user's shared budget. [Linear's rate limits](https://linear.app/developers/rate-limiting) allow 2,500 GraphQL requests per hour for API keys and 5,000 for OAuth users or App users, subject to endpoint and complexity limits. Multiple keys for the same user share that budget. Tool calls, MCP transport HTTP requests and native GraphQL requests are different counts; MCP's internal GraphQL cost is not visible to this client. The local metadata cache and cooldown do not reserve capacity across machines or separate saved connections.

## Interpret effects honestly

A wrong workspace, unsupported operation, missing permission, inaccessible record, malformed response or rate limit is an error. Do not replace it with a login page, success or an empty result. Do not loop on rate limits.

Pre-save comparisons and shared snapshots can reject detected conflicts. They do not promise remote atomic compare-and-swap or an atomic cross-resource transaction.

A confirmed backend write is successful. Linear may change rich-text and field representations; differences from the request do not fail the write or produce transformation warnings. The actual saved resource is the source of truth, not a byte-preserving copy of submitted Markdown.

A failed read after a confirmed write is a readback problem, not unknown delivery. Keep the applied effect and all known created IDs and Read links. Read that same resource when access is available; do not repeat the write to obtain a successful read or invent saved content and anchors.

A code ending in `_CONNECT_FAILED`, such as `LINEAR_OPERATION_CONNECT_FAILED`, means a connection to Linear never opened. A typed operation or comment creation that reports it with a `not-applied` effect was not sent and can be retried; with an `unknown` effect, an earlier step may have applied. `LINEAR_AXI_TIMEOUT` means the local linear-axi process did not finish in time; a write it was running has an unknown effect. When a field write or comment `#body` edit has an unknown effect, the provider reads the resource once: if it already shows every requested value, the write is reported as applied. Otherwise the effect stays unknown.

Unknown creation can already have created a record. Keep returned identities and inspect the target. For an issue creation, search the intended project and inspect possible matches. If no matching issue can be confirmed, correct any reported validation problem and retry; then check for duplicates and remove only duplicates created by your attempts, preserving any issue with independent work. Continue the task without asking the user to resolve an uncertain result. Other unknown creations and uploads may have stored data; inspect the target and do not replay them unless the effect is established.

Failure panels distinguish rejected writes, unknown delivery and confirmed writes with unavailable readback. They show safe causes without copying private backend diagnostics. Keep completed, unapplied and rollback effects separate; inspect unknown effects before deciding whether to retry.

## Continue from fresh resources

After a save, Read again before editing further. Remote mutation receipts do not grant a new reusable text selection. In IDE mode, shared result handles can be stale or expire after reload/session changes. Use actual anchors or unchanged results; do not reconstruct them from previews. In standalone mode, use explicit paths and the standalone tool's own line#hash anchors or unique exact text.

Uploads and attachment operations are separate effects. Replacement can leave a new asset or both attachments after partial failure. Keep the old asset and unrelated references; do not compensate by deleting unknown remote state.

## Approval boundaries

In IDE mode, high-risk actions use Pi Agent IDE's shared approval policy. Without a configured or remembered grant, the dialog offers Deny, Allow once and Allow for session; refusal, cancellation, dialog failure or unavailable UI grants no permission. Herdr shows waiting only while a shared terminal dialog is open. Each dispatch still consumes its exact-target, exact-payload permit.

Without the IDE extension, high-risk standalone actions always require an interactive confirmation. No standalone YOLO switch or remembered approval bypass is available. IDE YOLO settings do not suppress this confirmation. Denial, cancellation, dialog failure or unavailable UI prevents dispatch.

With the IDE loaded, use /agent-ide-settings to change Linear YOLO (pi-agent-linear-yolo) in Global or Project scope. Product defaults are off. On skips existing confirmations, Off overrides common YOLO, and Default inherits pi-agent-ide-yolo. Allow for session remembers the same owner and dialog category across targets, /reload and reopening that saved session; it does not carry to a new session. Remembered grants are separate from persistent YOLO settings. Read docs:ide-settings before editing saved configuration.

In IDE mode, YOLO and session grants work without UI but never bypass identity, payload, capability or AXI authorization checks. They supply dialog permission, not user intent. Standalone mode keeps the same technical checks and has no unattended high-risk bypass.

Deletion, merge and other high-risk effects require permission for the exact target and action. Full access is capability, not blanket consent. Ordinary file replacement may remove only its addressed old attachment after verifying the new one under the approved replacement contract.

Credentials never go to external hosts or unvalidated redirects. Signed upload requests use their returned headers, not indiscriminate bearer forwarding.

Return to the relevant [domain guide](docs:linear) after the blocker is understood.
