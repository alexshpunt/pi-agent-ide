import { describe, expect, test, vi } from "vitest";
import { syncGitHubIssue, type GitHubIssueEvent } from "#scripts/github-issue-to-linear.ts";

const event: GitHubIssueEvent = {
  action: "opened",
  repository: { id: 123, full_name: "alexshpunt/pi-agent-ide" },
  issue: {
    id: 456,
    number: 7,
    title: "A bug with $(shell) and `code`",
    body: "## Steps\n\nOriginal **Markdown** with 'quotes'.",
  },
};
const linearIssue = {
  id: "",
  identifier: "LPT-900",
  url: "https://linear.app/alexshpunt/issue/LPT-900/test",
};

function api() {
  let stored: typeof linearIssue | undefined;
  let archived = false;
  let loseResponse = false;
  const inputs: Record<string, unknown>[] = [];
  const request = vi.fn<typeof fetch>(async (_url, options) => {
    const { query, variables } = JSON.parse(options?.body as string) as {
      query: string;
      variables: { id: string; input: Record<string, unknown> };
    };
    expect(options?.headers).toMatchObject({ Authorization: "test-key" });
    if (query.includes("issueCreate")) {
      if (stored) return Response.json({ errors: [{ message: "Duplicate ID" }] });
      inputs.push(variables.input);
      stored = { ...linearIssue, id: String(variables.input.id) };
      if (loseResponse) throw new Error("Connection lost after creation");
      return Response.json({ data: { issueCreate: { success: true, issue: stored } } });
    }
    if (archived) expect(query).toContain("includeArchived: true");
    expect(variables.id).toMatch(/^[a-f0-9-]{14}5[a-f0-9-]{21}$/u);
    return Response.json({ data: { issues: { nodes: stored ? [stored] : [] } } });
  });
  return {
    request,
    inputs,
    archive: () => {
      archived = true;
    },
    loseResponse: () => {
      loseResponse = true;
    },
  };
}

describe("GitHub issues to Linear", () => {
  test("copies original content and source identity into the right team and project", async () => {
    const server = api();
    const result = await syncGitHubIssue(event, "test-key", server.request);
    expect(result).toMatchObject({ created: true, issue: { identifier: "LPT-900" } });
    expect(server.inputs).toHaveLength(1);
    expect(server.inputs[0]).toMatchObject({
      id: "89d3ea20-c2eb-57c2-b4c0-1b0d0425f3d3",
      title: event.issue.title,
      teamId: "dd4e96d8-1474-43b6-a4c4-73ebea149ad4",
      projectId: "5362922a-2e3b-4853-851d-0f9969fa35d4",
    });
    const description = String(server.inputs[0]?.description);
    expect(description).toContain("https://github.com/alexshpunt/pi-agent-ide/issues/7");
    expect(description).toContain("GitHub repository ID: 123");
    expect(description).toContain("GitHub issue ID: 456");
    expect(description.endsWith(event.issue.body ?? "")).toBe(true);
  });

  test.each([null, undefined, ""])("handles a missing or empty body: %s", async (body) => {
    const server = api();
    await syncGitHubIssue(
      { ...event, issue: { ...event.issue, body } },
      "test-key",
      server.request,
    );
    expect(server.inputs[0]?.description).toContain(
      "https://github.com/alexshpunt/pi-agent-ide/issues/7",
    );
    expect(server.inputs[0]?.description).not.toMatch(/undefined|null/u);
  });

  test("reruns reuse the same issue even after its original content changes or it is archived", async () => {
    const server = api();
    const first = await syncGitHubIssue(event, "test-key", server.request);
    server.archive();
    const second = await syncGitHubIssue(
      { ...event, issue: { ...event.issue, title: "Changed", body: "Changed" } },
      "test-key",
      server.request,
    );
    expect(second).toEqual({ created: false, issue: first.issue });
    expect(server.inputs).toHaveLength(1);
  });

  test("recovers when Linear created the issue but its response was lost", async () => {
    const server = api();
    server.loseResponse();
    const result = await syncGitHubIssue(event, "test-key", server.request);
    expect(result.created).toBe(false);
    await syncGitHubIssue(event, "test-key", server.request);
    expect(server.inputs).toHaveLength(1);
  });

  test("concurrent attempts converge on one Linear issue", async () => {
    const server = api();
    const results = await Promise.all([
      syncGitHubIssue(event, "test-key", server.request),
      syncGitHubIssue(event, "test-key", server.request),
    ]);
    expect(results[0].issue).toEqual(results[1].issue);
    expect(server.inputs).toHaveLength(1);
  });

  test.each([
    { status: 401, body: { errors: [{ message: "Unauthorized" }] } },
    { status: 200, body: { errors: [{ message: "Linear mutation failed" }] } },
    { status: 200, body: { data: { issueCreate: { success: false, issue: null } } } },
  ])("does not hide a failed creation: $status $body", async ({ status, body }) => {
    const request = vi.fn<typeof fetch>(async (_url, options) => {
      const { query } = JSON.parse(options?.body as string) as { query: string };
      return query.includes("issueCreate")
        ? Response.json(body, { status })
        : Response.json({ data: { issues: { nodes: [] } } });
    });
    await expect(syncGitHubIssue(event, "test-key", request)).rejects.toThrow(/Linear/u);
  });

  test("a lookup failure never attempts creation", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ errors: [{ message: "Lookup failed" }] }),
    );
    await expect(syncGitHubIssue(event, "test-key", request)).rejects.toThrow("Lookup failed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("missing authentication and unrelated events fail before any API call", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(syncGitHubIssue(event, "", request)).rejects.toThrow("LINEAR_API_KEY");
    await expect(
      syncGitHubIssue({ ...event, action: "edited" }, "test-key", request),
    ).rejects.toThrow("Expected an opened GitHub issue");
    await expect(
      syncGitHubIssue(
        { ...event, repository: { ...event.repository, full_name: "someone/fork" } },
        "test-key",
        request,
      ),
    ).rejects.toThrow("Expected an opened GitHub issue");
    expect(request).not.toHaveBeenCalled();
  });
});
