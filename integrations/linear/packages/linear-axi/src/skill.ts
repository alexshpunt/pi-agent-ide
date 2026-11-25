import { topHelp } from "./commands/help.ts";

export const SKILL_DESCRIPTION =
  "Operate Linear through the linear-axi CLI - issues, projects, teams, users, comments, documents, " +
  "milestones, cycles, statuses, labels, auth, and repo project setup. Use whenever a task touches " +
  "Linear: listing or creating issues, updating project work, reading documents, or managing comments. " +
  "Do not use for non-Linear issue trackers.";

export const DESCRIPTION =
  "Agent ergonomic wrapper around the configured Linear MCP server. Prefer this over raw Linear MCP calls for Linear operations.";

export function extractCommandsBlock() {
  const match = topHelp().match(/^(commands\[\d+\]:\n(?: {2}.*\n)+)/m);
  if (!match) {
    throw new Error("Could not find commands block in top help");
  }
  return match[1].trimEnd();
}

export function createSkillMarkdown() {
  return `---
name: linear-axi
description: ${JSON.stringify(SKILL_DESCRIPTION)}
---

# linear-axi

${DESCRIPTION}

When the native \`linear_axi\` tool is available, prefer it over shell execution and pass the CLI command group as \`action\` plus the remaining command arguments as \`args\`. Otherwise, check whether \`linear-axi\` is installed before using it. If it is missing, ask the user to install the pi package with \`pi install npm:@nikolauska/linear-axi\` or the standalone CLI globally with \`npm install -g @nikolauska/linear-axi\`.
linear-axi requires Node.js 24 or newer.

Use \`linear-axi auth status --json\` for safe connection status. Ask the user to use \`/linear\` in Pi Agent Linear for private authorization controls, or to run \`linear-axi auth login\` in their own terminal. Leave key/token import and callback completion to private stdin callers. Do not run login, import or callback completion through agent tools. Keep credentials, callback URLs and one-time authorize links out of tool arguments/results, conversations and logs. Never inspect or copy credential/cache files.

Select one saved connection per Pi session. Keep named credentials in the backend's shared local store and only profile IDs in session state. Use its reported MCP/native/file capabilities; refuse unavailable access instead of substituting another credential. Have the user explicitly select a saved connection with /linear switch or add another connection without logging out. Read again after switching before editing. Local \`auth logout\` removes the selected saved connection for all its sessions, clears its default if applicable, and blocks fallback without revoking access in Linear. Use an explicitly assigned default only for new sessions; do not change it when switching an existing session. Request explicit confirmation for supported remote revocation, and never retry an unknown outcome blindly. Normal user login uses Linear MCP OAuth/DCR and PKCE without a new shared product app; own-app user/app OAuth is optional.

Before a managed connection is selected, legacy operator mode preserves existing MCP and app configuration, which may represent different principals. Do not describe that mode as one verified identity or use it as fallback after managed logout.

Comments use the selected connection's own identity without persona names or avatar overrides. Legacy persona configuration and role variables are ignored. Legacy App credentials still load from the ignored operator \`.env\`; explicit process values win. Set \`LINEAR_AXI_ENV_FILE\` to select another path. Never print token or credential values.

In legacy operator mode, native app scopes come from explicit \`LINEAR_AXI_TOKEN_SCOPE\`, then the non-secret \`\${PI_CODING_AGENT_DIR:-~/.pi/agent}/config/linear-axi/app-scope.json\`. \`LINEAR_AXI_APP_SCOPE_FILE\` overrides its path. Missing config keeps \`read,comments:create\`; invalid config refuses exchange. Configured bearer tokens still win. A valid cached token is reused until expiry or an explicit operator refresh. Ask before changing scopes: doing so can revoke other app-actor tokens. Never inspect credential/cache files to make this change.

## When to use

Use linear-axi whenever a task touches Linear: listing, viewing, creating, or updating issues; browsing or editing projects and documents; creating or listing comments; checking teams, users, labels, cycles, milestones, or statuses; or binding the current repo to a default Linear project.

## Workflow

1. Use \`linear_axi\` with \`action: "dashboard"\`, or run \`linear-axi\` with no arguments, for a dashboard of the current repo. Uninitialized repos show setup hints instead of workspace-wide issue counts.
2. List Linear projects with \`linear-axi projects list\`, then bind a repository with \`linear-axi init --project "<project>"\`; this accepts a project id, name, or slug, validates the project, and stores discovered workspace metadata in \`.linear-project\`.
3. Drill in command-first: \`issues list\`, \`issues view <id>\`, \`projects list\`, \`projects view <id-or-slug> --full\`, \`teams view <id-or-key> --full\`, \`documents view <id>\`, \`comments list --issue <id>\`, and so on.
4. Add \`--fields\` for columns, \`--cursor\` for pagination, and \`--full\` only when complete content is needed.
5. Linear operation responses include contextual next-step hints under \`help:\` when recovery or follow-up is useful - follow them.
6. Before a destructive or broad mutation, verify the target and ask for confirmation unless the user already requested that exact change.

## Commands

\`\`\`
${extractCommandsBlock()}
\`\`\`

Installed copies also inherit the SDK built-in \`update\` command.
Run \`linear-axi update --check\` to compare the installed version with npm, or \`linear-axi update\` to upgrade.

Run \`linear-axi --help\` for global flags, \`linear-axi <resource> --help\` for grouped subcommands, or \`linear-axi <resource> <action> --help\` for focused flags.

## Native search and read-only resources

Run \`linear-axi search issues --query "SSH" --workspace <slug> --include-comments\` for native GraphQL search. The other native kinds are \`projects\` and \`documents\`. In managed mode, use the selected connection's native capability; refuse unavailable access without substituting another credential. In legacy mode, native app authorization may differ from MCP. A bounded page has at most 50 identities and includes \`hasMore\`, a continuation cursor, and the native total. Issue team/project IDs use hard API filters; project/document constraints post-filter native pages, so an empty page may still have a continuation. Never claim global full-content coverage or invent snippets. Rate-limit and permission failures are explicit safe codes.

Run \`linear-axi resources list teams --query ENG --workspace <slug>\` for a supported MCP directory query, not native full-text search. Supported directories are teams, users, labels, cycles, statuses, milestones, releases, and custom views (\`views\`). Cycles/statuses require \`--scope <team-id>\`; milestones require \`--scope <project-id>\`. Parent-list name matching reports its limited coverage. \`resources view <kind> <id> --workspace <slug>\` reads one explicit object; an attachment read returns its current download/link metadata only. No crawler, index, credential forwarding, or mutations are added by these list/view commands. Use the CLI when the installed tool's action enum does not advertise these groups.

For direct children, resolve the parent UUID first. Use \`search issues --parent-id <UUID>\` with a query for native full-text search, including comments. Filtering may produce empty candidate pages; follow the actual cursor until complete. For a list without a search term, use \`resources children --workspace <slug> --parent-id <UUID>\`. Both verify the direct parent and workspace and never include grandchildren.

## Internal provider transport

\`resources capabilities --workspace <slug>\` exposes only approved live operation schemas and annotations as JSON-encoded rows. \`resources invoke <approved-operation> --workspace <slug> --input-file <local-json-file>\` is bounded internal transport for resource providers, not a new agent tool family. It validates the workspace, fixed 68-operation catalog and actual JSON Schema before dispatch. Unknown fields, invalid values, empty targets and input above 2 MiB refuse before mutation. Local UTF-8 JSON input must be a regular file, not a symlink.

Successful receipts preserve full JSON resource data with an effect. A read failure is not-applied; any mutating failure after dispatch is unknown and is never replayed. Raw error bodies and credentials are not printed. The calling provider owns explicit approval for destructive actions and saved-resource verification; server annotations do not authorize them.

## Private files

Run \`linear-axi assets upload --workspace <slug> --file <local-file>\` for a private binary upload. Add \`--issue ENG-12\` only to attach to that explicit issue; \`--title\` and \`--content-type\` are optional. No issue means no attachment or text change. Files must be local regular files, not symlinks, and at most 25 MiB. Receipts include size/SHA-256 and separate upload/attachment effects. A failed attachment does not hide a completed upload's asset URL. Never replay an unknown result.

\`assets download --workspace <slug> --url <private-asset-url> --output <new-local-file>\` downloads original bytes from the documented HTTPS uploads host only. Redirects, signed URL query strings and output overwrites are refused. In managed mode, use the selected connection only when storage is supported. Legacy mode uses its configured app authorization. Working MCP Read does not prove storage permission. Do not request different app scopes without approval, since doing so can revoke other app tokens. Use the CLI if the installed tool does not advertise assets. Never print tokens or signed PUT URLs.

Project updates accept \`--description-file\` as well as inline descriptions. Document and comment file flags remain \`--content-file\` and \`--body-file\`.

## Tips

- Never print bearer-token environment variables or OAuth tokens.
- Native tool example: \`{"action":"issues","args":["list","--assignee","me","--limit","25"]}\` corresponds to \`linear-axi issues list --assignee me --limit 25\`.
- Linear command output is TOON-encoded and token-efficient; pipe through grep/head only when a list is very long.
- Default issue and project lists are grouped by status, show active work first, and keep ids last. Use \`--fields\` when you need a custom column order.
- Mutations validate targets and report compact results. After a transport or response failure, inspect the target before retrying to avoid duplicate changes.
- For multi-line markdown descriptions, comments, or documents, write the text to a UTF-8 file and pass \`--description-file <path>\`, \`--body-file <path>\`, or \`--content-file <path>\`.
- Repository project defaults are validated before an issue, document, or milestone command uses them unless \`--project <project>\` overrides them. Use \`--all-projects\` on issue and document list commands only when a workspace-wide list is intended.
`;
}
