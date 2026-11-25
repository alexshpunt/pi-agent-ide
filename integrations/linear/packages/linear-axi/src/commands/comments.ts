import { isRecord, type InputRecord, type ParsedFlags, type Runtime } from "#axi/types.ts";
import { requireText } from "./command-input.ts";
import { parseFlags, usage } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import {
  appendContinuationHelp,
  applyTextFileFlag,
  collectKnownArgs,
  dispatchCommandGroup,
  formatCommandArg,
  requireValue,
} from "#axi/lib/cli-helpers.ts";
import { compactComment, paginationInfo } from "#axi/lib/linear-format.ts";
import { asArray, extractData } from "#axi/lib/mcp-tools.ts";
import { commentCreateHelp, commentListHelp, groupHelp } from "./help.ts";
import { resourceOperationFailure } from "#axi/lib/resource-failure.ts";
import {
  DEFAULT_LIMIT,
  ensureIssueExists,
  rejectUnsupportedCommentFlags,
  renderMutation,
} from "./shared.ts";

const COMMENT_CREATE_HELP = ['Run `linear-axi comments create --issue LIN-123 --body "Ready"`'];
const COMMENT_LIST_FIELDS = ["issue", "limit", "cursor", "orderBy"];
const COMMENT_CONTINUATION_FLAGS = [
  ...COMMENT_LIST_FIELDS.filter((name) => name !== "cursor"),
  "full",
];
const COMMENT_MUTATION_FIELDS = ["issue", "body"];

export async function commentCommand(args: string[], runtime: Runtime) {
  return dispatchCommandGroup(args, {
    name: "comments",
    help: () => groupHelp("comments", ["list", "create"]),
    handlers: {
      list: (rest) => listCommentsCommand(rest, runtime),
      create: (rest) => createCommentCommand(rest, runtime),
    },
    unknownHelp: [
      "Run `linear-axi comments list --issue LIN-123`",
      'Run `linear-axi comments create --issue LIN-123 --body "..."`',
    ],
  });
}

async function listCommentsCommand(args: string[], runtime: Runtime) {
  const parsed = parseFlags(args, {
    boolean: ["help", "full"],
    example: "comments list --issue LIN-123",
  });
  if (parsed.help) return commentListHelp();
  rejectUnsupportedCommentFlags(parsed);
  const issueId = requireText(parsed.issue, "comments list requires --issue", [
    "Run `linear-axi comments list --issue LIN-123`",
  ]);
  const { issue: _issue, ...toolArgs } = collectKnownArgs(parsed, COMMENT_LIST_FIELDS);
  toolArgs.limit ??= DEFAULT_LIMIT;
  toolArgs.issueId = issueId;
  const result = await runtime.client.callTool("list_comments", toolArgs);
  const data = extractData(result);
  const comments = asArray(data);
  const rows = parsed.full ? [] : comments.map(compactComment);
  const rowCount = comments.length;
  const page = paginationInfo(data, rowCount);
  const help = [
    `Run \`linear-axi comments create --issue ${issueId} --body "..."\` to add a comment`,
  ];
  if (!parsed.full && rows.some((comment) => comment.truncated)) {
    help.push(
      `Run \`linear-axi comments list --issue ${formatCommandArg(issueId)} --full\` to show complete comment bodies`,
    );
  }
  appendContinuationHelp(
    help,
    "linear-axi comments list",
    parsed,
    COMMENT_CONTINUATION_FLAGS,
    page.cursor,
  );
  return renderToon({
    count: page.count,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    comments: parsed.full ? data : rows.map(({ truncated: _truncated, ...comment }) => comment),
    help,
  });
}

async function createCommentCommand(args: string[], runtime: Runtime) {
  const parsed = parseFlags(args, {
    boolean: ["help"],
    example: 'comments create --issue LIN-123 --body "Ready"',
  });
  if (parsed.help) return commentCreateHelp();
  rejectUnsupportedCommentFlags(parsed);
  if (parsed.id) {
    throw usage("comments create supports issue comments only", COMMENT_CREATE_HELP);
  }
  let toolArgs: InputRecord;
  try {
    toolArgs = await commentToolArgs(parsed, runtime);
  } catch (error) {
    throw resourceOperationFailure("OPERATION", error, "not-applied");
  }
  const issueId = requireText(
    toolArgs.issueId,
    "comments create requires --issue",
    COMMENT_CREATE_HELP,
  );
  requireValue(toolArgs.body, "--body or --body-file is required", COMMENT_CREATE_HELP);
  let dispatched = false;
  try {
    await ensureIssueExists(issueId, runtime);
    dispatched = true;
    return await saveComment(toolArgs, runtime);
  } catch (error) {
    const failure = resourceOperationFailure("OPERATION", error);
    // save_comment is one request; a connection that never opened sent nothing.
    throw resourceOperationFailure(
      "OPERATION",
      failure,
      dispatched && failure.reason !== "CONNECT_FAILED" ? "unknown" : "not-applied",
    );
  }
}

async function commentToolArgs(parsed: ParsedFlags, runtime: Runtime) {
  const { issue, ...toolArgs } = collectKnownArgs(parsed, COMMENT_MUTATION_FIELDS);
  if (issue) toolArgs.issueId = issue;
  await applyTextFileFlag(toolArgs, parsed, {
    flag: "body-file",
    field: "body",
    cwd: runtime.cwd,
    preserveExisting: true,
  });
  return toolArgs;
}

function compactCreatedComment(comment: unknown) {
  if (!isRecord(comment) || typeof comment.id !== "string" || !comment.id.trim())
    throw new Error("LINEAR_INVALID_RESPONSE");
  return compactComment(comment);
}
async function saveComment(toolArgs: InputRecord, runtime: Runtime) {
  return renderMutation(runtime, {
    tool: "save_comment",
    args: toolArgs,
    help: [
      'Run `linear-axi comments create --issue LIN-123 --body "Ready"`',
      `Run \`linear-axi comments list --issue ${formatCommandArg(toolArgs.issueId)}\` to verify comments`,
    ],
    render: (comment) => {
      const { truncated, ...compact } = compactCreatedComment(comment);
      return {
        comment: compact,
        ...(truncated
          ? {
              help: [
                `Run \`linear-axi comments list --issue ${formatCommandArg(toolArgs.issueId)} --full\` to show complete comment bodies`,
              ],
            }
          : {}),
      };
    },
  });
}
