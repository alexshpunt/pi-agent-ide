import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const repository = "alexshpunt/pi-agent-ide";
const teamId = "dd4e96d8-1474-43b6-a4c4-73ebea149ad4";
const projectId = "5362922a-2e3b-4853-851d-0f9969fa35d4";

/** The opened GitHub issue payload used by the Actions workflow. */
export interface GitHubIssueEvent {
  action: string;
  repository: { id: number; full_name: string };
  issue: {
    id: number;
    number: number;
    title: string;
    body?: string | null;
    pull_request?: unknown;
  };
}

interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
}

function sourceId(event: GitHubIssueEvent): string {
  // Keep this hash stable across reruns; Linear only accepts client IDs in UUID v4 format.
  // The namespace and immutable GitHub IDs keep the link independent of title/body edits.
  const bytes = createHash("sha1")
    .update(Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex"))
    .update(`github.com/repositories/${event.repository.id}/issues/${event.issue.id}`)
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x40, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Create one Linear issue per GitHub issue. Reruns reuse its stable UUID, including
 * archived issues. A failed or lost creation response is reconciled by that UUID.
 * Existing issues are never overwritten. API failures reject and fail the workflow.
 */
export async function syncGitHubIssue(
  event: GitHubIssueEvent,
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<{ created: boolean; issue: LinearIssue }> {
  if (!apiKey.trim()) throw new Error("Missing GitHub Actions secret LINEAR_API_KEY");
  if (
    event.action !== "opened" ||
    event.repository.full_name !== repository ||
    !Number.isSafeInteger(event.repository.id) ||
    event.repository.id <= 0 ||
    !Number.isSafeInteger(event.issue.id) ||
    event.issue.id <= 0 ||
    !Number.isSafeInteger(event.issue.number) ||
    event.issue.number <= 0 ||
    typeof event.issue.title !== "string" ||
    !event.issue.title.trim() ||
    (event.issue.body != null && typeof event.issue.body !== "string") ||
    event.issue.pull_request !== undefined
  ) {
    throw new Error(`Expected an opened GitHub issue in ${repository}`);
  }

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await request("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey.trim() },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Linear API returned HTTP ${response.status}`);
    const result = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (result.errors?.length) {
      throw new Error(`Linear API: ${result.errors.map((error) => error.message).join("; ")}`);
    }
    if (!result.data) throw new Error("Linear API returned no data");
    return result.data;
  }

  const id = sourceId(event);
  async function findExisting(): Promise<LinearIssue | undefined> {
    const data = await graphql<{ issues?: { nodes?: LinearIssue[] } }>(
      `
        query GitHubIssue($id: ID!) {
          issues(filter: { id: { eq: $id } }, includeArchived: true, first: 1) {
            nodes {
              id
              identifier
              url
            }
          }
        }
      `,
      { id },
    );
    if (!Array.isArray(data.issues?.nodes)) throw new Error("Linear lookup returned no issue list");
    return data.issues.nodes[0];
  }

  const existing = await findExisting();
  if (existing) return { created: false, issue: existing };

  const url = `https://github.com/${repository}/issues/${event.issue.number}`;
  const source = `GitHub issue: [${repository}#${event.issue.number}](${url})\nGitHub repository ID: ${event.repository.id}\nGitHub issue ID: ${event.issue.id}`;
  try {
    const data = await graphql<{ issueCreate?: { success: boolean; issue: LinearIssue | null } }>(
      `
        mutation GitHubIssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id
              identifier
              url
            }
          }
        }
      `,
      {
        input: {
          id,
          teamId,
          projectId,
          title: event.issue.title,
          description: event.issue.body ? `${source}\n\n---\n\n${event.issue.body}` : source,
        },
      },
    );
    if (!data.issueCreate?.success || data.issueCreate.issue?.id !== id) {
      throw new Error("Linear issue creation did not succeed");
    }
    return { created: true, issue: data.issueCreate.issue };
  } catch (error) {
    // The mutation may have committed despite a timeout, or another run won the race.
    const recovered = await findExisting();
    if (recovered) return { created: false, issue: recovered };
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("Missing GITHUB_EVENT_PATH");
  const event = JSON.parse(readFileSync(eventPath, "utf8")) as GitHubIssueEvent;
  const result = await syncGitHubIssue(event, process.env.LINEAR_API_KEY ?? "");
  const message = `${result.created ? "Created" : "Reused"} ${result.issue.identifier}: ${result.issue.url}`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  }
}
