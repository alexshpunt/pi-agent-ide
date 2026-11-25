import { asRecord, asArrayOfUnknown } from "./types.ts";
import { isConnectionFailure } from "./lib/connection-failure.ts";
import { rejectRateLimit, type RateLimitObserver } from "./rate-limit.ts";
import { authorizationHeader, type RefreshableNativeTokenProvider } from "./app-token.ts";
import { NativeRawGraphqlClient, type RawGraphqlReceipt } from "./native-raw-graphql.ts";
import {
  NativeWorkflowClient,
  type WorkflowCapability,
  type WorkflowOperation,
  type WorkflowReceipt,
} from "./native-workflow.ts";
import {
  nativeChildrenPage,
  nativeChildrenQuery,
  type NativeChildrenInput,
  type NativeChildrenPage,
} from "./lib/native-children.ts";
import {
  nativeSearchPage,
  nativeSearchQuery,
  type NativeSearchInput,
  type NativeSearchPage,
} from "./lib/native-search.ts";

/** MCP issue identity to correlate with the independently authorized native App read. */
export interface NativeIssueEstimateInput {
  workspace: string;
  issueId: string;
  identifier: string;
  signal?: AbortSignal;
}
/** Verified native issue identity and its actual estimate; null means explicitly unset. */
export interface NativeIssueEstimate {
  id: string;
  identifier: string;
  estimate: number | null;
}
/** Native App search and optional fixed resource helpers using existing authorization. */
export interface NativeSearchClient {
  executeGraphql?(
    input: unknown,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<RawGraphqlReceipt>;
  searchObjects(input: NativeSearchInput): Promise<NativeSearchPage>;
  listChildren?(input: NativeChildrenInput): Promise<NativeChildrenPage>;
  /** App actor may differ from MCP; implementations must verify workspace and issue correlation. */
  readIssueEstimate?(input: NativeIssueEstimateInput): Promise<NativeIssueEstimate>;
  /** Local fixed schemas; available only with an independently authorized native workflow client. */
  workflowCapabilities?(): WorkflowCapability[];
  /** Verify native ownership and attempt each fixed mutation once; retain unknown target identity. */
  invokeWorkflow?(
    operation: WorkflowOperation,
    input: unknown,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<WorkflowReceipt>;
}

function estimateRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("LINEAR_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
/** Existing App authorization for native reads and fixed workflow saves. */
export class LinearGraphqlClient {
  private readonly endpoint: string;
  private readonly tokenProvider: RefreshableNativeTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly workflow: NativeWorkflowClient;
  private readonly raw: NativeRawGraphqlClient;
  async executeGraphql(
    input: unknown,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<RawGraphqlReceipt> {
    return this.raw.execute(input, workspace, signal);
  }
  private readonly onRateLimit?: RateLimitObserver;

  constructor({
    endpoint = "https://api.linear.app/graphql",
    tokenProvider,
    fetchImpl = fetch,
    onRateLimit,
  }: {
    endpoint?: string;
    tokenProvider: RefreshableNativeTokenProvider;
    fetchImpl?: typeof fetch;
    onRateLimit?: RateLimitObserver;
  }) {
    this.endpoint = endpoint;
    this.tokenProvider = tokenProvider;
    this.fetchImpl = fetchImpl;
    this.onRateLimit = onRateLimit;
    this.workflow = new NativeWorkflowClient({ endpoint, tokenProvider, fetchImpl, onRateLimit });
    this.raw = new NativeRawGraphqlClient({ tokenProvider, fetchImpl, onRateLimit });
  }

  /** Publish the local fixed workflow schemas, not untrusted server-defined write operations. */
  workflowCapabilities(): WorkflowCapability[] {
    return this.workflow.capabilities();
  }

  /** Use existing App authorization for a verified workflow read or a single save attempt. */
  invokeWorkflow(
    operation: WorkflowOperation,
    input: unknown,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<WorkflowReceipt> {
    return this.workflow.invoke(operation, input, workspace, signal);
  }
  /** Return bounded native identities; never expose response bodies or bearer tokens in errors. */
  async searchObjects(input: NativeSearchInput): Promise<NativeSearchPage> {
    return nativeSearchPage(await this.readQuery(nativeSearchQuery(input), input.signal), input);
  }

  /** Read direct children with the same existing native API authorization. */
  async listChildren(input: NativeChildrenInput): Promise<NativeChildrenPage> {
    return nativeChildrenPage(
      await this.readQuery(nativeChildrenQuery(input), input.signal),
      input,
    );
  }

  /**
   * Fill MCP's omitted estimate using existing App authorization, never inferred defaults.
   * The App actor can differ from MCP: verify both workspace ownership and issue identity.
   * Uses a fixed read-only query; failures expose only sanitized codes.
   */
  async readIssueEstimate(input: NativeIssueEstimateInput): Promise<NativeIssueEstimate> {
    if (
      !/^[A-Za-z0-9_-]+$/u.test(input.workspace) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.issueId) ||
      !/^[A-Za-z0-9_]+-[0-9]+$/u.test(input.identifier)
    )
      throw new Error("LINEAR_INPUT_INVALID");
    try {
      const signal = AbortSignal.any([
        AbortSignal.timeout(30_000),
        ...(input.signal ? [input.signal] : []),
      ]);
      const root = estimateRecord(
        await this.readQuery(
          {
            query: `query IssueEstimate($id: String!) {
          viewer { organization { urlKey } }
          issue(id: $id) {
            id identifier estimate
            team { organization { urlKey } }
          }
        }`,
            variables: { id: input.issueId.toLowerCase() },
          },
          signal,
        ),
      );
      const viewerWorkspace = estimateRecord(estimateRecord(root.viewer).organization).urlKey;
      const issue = estimateRecord(root.issue);
      const issueWorkspace = estimateRecord(estimateRecord(issue.team).organization).urlKey;
      if (
        viewerWorkspace !== input.workspace ||
        issueWorkspace !== input.workspace ||
        issue.id !== input.issueId.toLowerCase() ||
        issue.identifier !== input.identifier
      )
        throw new Error("LINEAR_IDENTITY_MISMATCH");
      if (
        issue.estimate !== null &&
        (typeof issue.estimate !== "number" || !Number.isFinite(issue.estimate))
      )
        throw new Error("LINEAR_INVALID_RESPONSE");
      return {
        id: issue.id,
        identifier: issue.identifier,
        estimate: issue.estimate,
      };
    } catch (error) {
      if (isConnectionFailure(error)) throw error;
      if (
        error instanceof Error &&
        [
          "LINEAR_GRAPHQL_AUTH_REQUIRED",
          "LINEAR_PERMISSION_DENIED",
          "LINEAR_RATE_LIMITED",
          "LINEAR_GRAPHQL_FAILED",
          "LINEAR_INVALID_RESPONSE",
          "LINEAR_IDENTITY_MISMATCH",
        ].includes(error.message)
      )
        throw error;
      throw new Error("LINEAR_GRAPHQL_FAILED", { cause: error });
    }
  }
  private async readQuery(
    request: { query: string; variables: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      let token: string;
      try {
        token = await authorizationHeader(this.tokenProvider, attempt === 1);
      } catch (error) {
        signal?.throwIfAborted();
        if (isConnectionFailure(error)) throw error;
        throw new Error("LINEAR_GRAPHQL_AUTH_REQUIRED", { cause: error });
      }
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { authorization: token, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
      if (response.status === 401 && attempt === 0) {
        await this.tokenProvider.clearCache();
        continue;
      }
      if (response.status === 401) throw new Error("LINEAR_GRAPHQL_AUTH_REQUIRED");
      if (response.status === 403) throw new Error("LINEAR_PERMISSION_DENIED");
      if (response.status === 429) throw new Error("LINEAR_RATE_LIMITED");
      if (!response.ok && response.status !== 400) throw new Error("LINEAR_GRAPHQL_FAILED");
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new Error("LINEAR_INVALID_RESPONSE");
      }
      const payload = estimateRecord(value);
      const errors = asArrayOfUnknown(payload.errors);
      if (payload.errors != null && !errors) throw new Error("LINEAR_INVALID_RESPONSE");
      if (errors?.length) {
        const codes = new Set(errors.map((error) => asRecord(asRecord(error)?.extensions)?.code));
        if (codes.has("RATELIMITED") || codes.has("RATE_LIMITED"))
          return rejectRateLimit(response.headers, this.onRateLimit);
        if (codes.has("FORBIDDEN")) throw new Error("LINEAR_PERMISSION_DENIED");
        if (codes.has("UNAUTHENTICATED")) throw new Error("LINEAR_GRAPHQL_AUTH_REQUIRED");
        throw new Error("LINEAR_GRAPHQL_FAILED");
      }
      if (!response.ok) throw new Error("LINEAR_GRAPHQL_FAILED");
      return payload.data;
    }
    throw new Error("LINEAR_GRAPHQL_AUTH_REQUIRED");
  }
}
