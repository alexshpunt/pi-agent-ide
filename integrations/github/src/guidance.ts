import { readFile } from "node:fs/promises";
import type { AgentDocumentation } from "pi-agent-ide/api/documentation";

/** Register this package\'s short entry guide and lazy domain guides, not a parallel tool family. */
export async function loadGithubGuides(): Promise<readonly AgentDocumentation[]> {
  const domains = [
    ["github", "Start here and choose the GitHub domain guide"],
    ["github-discovery", "Repository-scoped API discovery and selected-resource text Search"],
    ["github-issues", "Issues, bodies, fields, labels, milestones and ordinary comments"],
    ["github-pulls", "Pull requests, diffs, review comments, threads and approval-gated reviews"],
    ["github-discussions", "Discussions, categories, comments and replies"],
    ["github-files", "Repository files, release assets and byte-preserving uploads"],
    ["github-api", "Universal API resources and arbitrary REST/GraphQL through Write in YOLO mode"],
    [
      "github-context",
      "PR and CI context, Projects, repository navigation and browser resource links",
    ],
    ["github-coverage", "Searchable resource-family index and the limits of installation access"],
    [
      "github-access",
      "Selected user/App authorization, permissions, bounds and unknown remote effects",
    ],
    [
      "github-setup",
      "Connect your own App or PAT and select local session/project profiles",
      "setup",
    ],
  ] as const;
  return Promise.all(
    domains.map(async ([id, description, file = id]) => ({
      id,
      description,
      triggers:
        id === "github"
          ? ["read", "search", "write", "replace", "insert", "copy", "move", "delete"].map(
              (tool) => ({
                tool,
                resourcePrefixes: ["github://", "https://github.com/", "https://api.github.com/"],
              }),
            )
          : [{ tool: "read", resourcePrefixes: [`docs:${id}`] }],
      markdown: await readFile(
        new URL(`./docs/${file}.md`, import.meta.resolve("#github-package")),
        "utf8",
      ),
    })),
  );
}
