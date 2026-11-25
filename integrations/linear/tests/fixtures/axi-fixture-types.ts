import { fileURLToPath } from "node:url";

type CommentFixtureEnvironment = Readonly<Record<
  | "HOME"
  | "XDG_CONFIG_HOME"
  | "CODEX_HOME"
  | "LINEAR_AXI_CONNECTION_FILE"
  | "LINEAR_AXI_MCP_URL"
  | "LINEAR_AXI_GRAPHQL_URL"
  | "LINEAR_AXI_TOKEN_FILE"
  | "LINEAR_AXI_CONNECTION_ID",
  string
>>;
type CommentActor = "user" | "app" | "user-oauth" | "unknown-oauth";
type CommentOutcome =
  | "success"
  | "http-401"
  | "http-403"
  | "http-429"
  | "http-307"
  | "forbidden"
  | "disconnect"
  | "invalid-receipt"
  | "missing-success"
  | "partial-success";

interface CommentFixtureOptions {
  resources?: boolean;
  estimate?: number | null;
  outcome?: CommentOutcome;
  unavailableReadback?: boolean;
  milestoneField?: boolean;
  issueProjection?: boolean;
  issueResponses?: Readonly<Record<string, Readonly<Record<string, unknown>> | null>>;
}

interface CommentFixture {
  directory: string;
  environment: CommentFixtureEnvironment;
  attempts: { transport: "mcp" | "native"; input: Record<string, unknown> }[];
  observed: {
    redirects: number;
    readsAfterMutation: number;
    authorizationMismatches: number;
    tokenExchanges: number;
  };
  quota: { issueInputs: Record<string, unknown>[]; estimateReads: number };
  resources?: { issueReads: number; pageInputs: Record<string, unknown>[]; mutations: Record<string, unknown>[] };
  close(): Promise<void>;
}

interface CommentFixtureModule {
  COMMENT_ID: string;
  COMMENT_ISSUE_ID: string;
  COMMENT_PAGE_CURSOR: string;
  COMMENT_WORKSPACE: string;
  PRIVATE_COMMENT_ERROR: string;
  commentCreateFixture(actor: CommentActor, options: CommentFixtureOptions): Promise<CommentFixture>;
}

/** Load the backend fixture at runtime without compiling its source in the adapter project. */
export async function loadCommentFixture(): Promise<CommentFixtureModule> {
  const fixturePath = fileURLToPath(import.meta.resolve("#linear-axi/test/fixtures/comment-create.ts"));
  return (await import(fixturePath)) as CommentFixtureModule;
}
