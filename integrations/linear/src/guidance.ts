import { readFile } from "node:fs/promises";
import type { AgentDocumentation } from "pi-agent-ide/api/documentation";

const domains = [
  [
    "linear-discovery",
    "Find Linear objects, list tasks by status, label or priority, and search text within selected resources",
  ],
  ["linear-issues", "Tasks, child tasks, typed fields and issue relationships"],
  [
    "linear-customer-requests",
    "Project-linked feedback, Customer Requests and manual Triage acceptance",
  ],
  ["linear-projects", "Create and manage projects without mixing fields with description text"],
  ["linear-documents", "Create, edit and rename Linear documents"],
  ["linear-discussions", "Read discussion pages and manage individual comments"],
  ["linear-files", "Read, attach, upload and replace files without editing binary content"],
  [
    "linear-organization",
    "Teams, users, labels, statuses, cycles, milestones, views and templates",
  ],
  ["linear-releases", "Releases, release notes, pipelines and status updates"],
  ["linear-activity", "Notifications and backend agent-guidance resources"],
  ["linear-workflow", "Native shared Agent Skills and managed template content"],
  ["linear-review", "Diffs, review threads and approval-gated review actions"],
  ["linear-access", "Authorization, limits, permission failures and uncertain remote effects"],
  ["linear-api", "Trusted raw GraphQL requests and readable response resources"],
] as const;

const resourcePrefixes = ["linear://", "raw:linear://", "https://linear.app/"];

/** Load this package's short entry guide and explicitly selected domain guides. */
export async function loadLinearGuides(): Promise<readonly AgentDocumentation[]> {
  const definitions: Omit<AgentDocumentation, "markdown">[] = [
    {
      id: "linear",
      description: "Start here and choose the Linear domain guide needed for the current task",
      triggers: [
        ...["read", "search", "write", "insert", "replace", "copy", "move", "delete"].map(
          (tool) => ({ tool, resourcePrefixes }),
        ),
        { tool: "linear_upload" },
      ],
    },
    ...domains.map(([id, description]) => ({
      id,
      description,
      // The registry requires a trigger. Explicit docs reads do not auto-append guides.
      triggers: [{ tool: "read", resourcePrefixes: [`docs:${id}`] }],
    })),
  ];
  return Promise.all(
    definitions.map(async (definition) => ({
      ...definition,
      markdown: await readFile(
        new URL(`./docs/${definition.id}.md`, import.meta.resolve("#linear-package")),
        "utf8",
      ),
    })),
  );
}
