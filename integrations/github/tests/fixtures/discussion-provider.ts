import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGithubProvider } from "#github/index.ts";
import { GithubBackend } from "#github/backend.ts";
import { GithubClient } from "#github/client.ts";
import { isolatedCoordinator } from "./github-coordinator.ts";
import { GithubCollaboration } from "#github/collaboration.ts";

export default async function discussionProvider(pi: ExtensionAPI): Promise<void> {
  const token = "local-discussion-fixture-token";
  const client = new GithubClient({
    async initialize() {},
    async getToken() { return { token, expiresAt: Date.now() + 3600000 }; },
    identity: { login: "fixture-app[bot]", name: "fixture-app[bot]", email: "fixture@app.invalid" },
  }, { coordinator: isolatedCoordinator(), fetcher: (async (input, init) => {
    if (String(input) !== "https://api.github.com/graphql" ||
        new Headers(init?.headers).get("authorization") !== "Bearer " + token)
      throw new Error("Unexpected fixture transport or identity");
    const request = JSON.parse(String(init?.body));
    if (/\bmutation\b/u.test(request.query)) throw new Error("This fixture is readonly");
    return Response.json({ data: { repository: {
      id: "R_repo", nameWithOwner: "owner/repo",
      discussion: {
        __typename: "Discussion", id: "D_one", number: 3, title: "Mode discussion",
        body: "Discussion first\nDiscussion last\n", updatedAt: "2026-10-10T20:00:00Z",
        url: "https://github.com/owner/repo/discussions/3",
        repository: { id: "R_repo", nameWithOwner: "owner/repo" }, category: { id: "C_one" },
      },
    } } });
  }) as typeof fetch });
  const clientFor = async () => client;
  await registerGithubProvider(pi, new GithubBackend(clientFor, new GithubCollaboration(clientFor)));
}
