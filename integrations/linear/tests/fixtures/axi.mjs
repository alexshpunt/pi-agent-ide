import { encode } from "@toon-format/toon-v4";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const [group, action, source, flag] = process.argv.slice(2);
if (group === "auth" && action === "epoch") {
  console.log(JSON.stringify({ epoch: "legacy", state: "legacy" }));
  process.exit(0);
}
if (group === "search") {
  const value = (key) => process.argv[process.argv.indexOf(key) + 1];
  console.log(
    encode({
      search: {
        kind: action,
        workspace: value("--workspace"),
        term: value("--query"),
        items: [
          {
            id: "ENG-12",
            title: "Task with body phrase",
            url: "https://linear.app/example/issue/ENG-12/fixture-task",
          },
        ],
        hasMore: !process.argv.includes("--cursor"),
        ...(!process.argv.includes("--cursor") ? { cursor: "next/page" } : {}),
        totalCount: 2,
        postFiltered: false,
      },
    }),
  );
  process.exit(0);
}
if (group === "resources") {
  const value = (key) => process.argv[process.argv.indexOf(key) + 1];
  const stateFile = "field-fixture.json";
  const initial = {
    id: "ENG-12",
    uuid: "11111111-1111-4111-8111-111111111111",
    title: "Field fixture",
    description: "Unchanged body",
    status: "Todo",
    labels: [],
    url: "https://linear.app/example/issue/ENG-12/fixture-task",
  };
  const schema = {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      state: { type: "string" },
      team: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
    },
  };
  if (action === "capabilities") {
    console.log(
      encode({
        capabilities: {
          workspace: "example",
          items: [
            {
              name: "get_issue",
              inputSchema: JSON.stringify({
                type: "object",
                properties: { id: { type: "string" } },
              }),
              annotations: "{}",
            },
            { name: "save_issue", inputSchema: JSON.stringify(schema), annotations: "{}" },
          ],
        },
      }),
    );
    process.exit(0);
  }
  if (action === "invoke") {
    let row = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : initial;
    const input = JSON.parse(readFileSync(value("--input-file"), "utf8"));
    if (source === "save_comment") {
      writeFileSync("comment-body.txt", input.body);
      row = { id: input.id, body: input.body };
    }
    if (source === "save_issue") {
      row = {
        ...row,
        ...(input.state !== undefined ? { status: input.state } : {}),
        ...(input.labels !== undefined ? { labels: input.labels } : {}),
        ...(input.id === undefined
          ? {
              id: "ENG-99",
              title: input.title,
              url: "https://linear.app/example/issue/ENG-99/fixture-task",
            }
          : {}),
      };
      writeFileSync(stateFile, JSON.stringify(row));
    }
    console.log(
      encode({
        invocation: {
          workspace: "example",
          operation: source,
          effect: "applied",
          data: JSON.stringify(row),
        },
      }),
    );
    process.exit(0);
  }
  if (action === "list")
    console.log(
      encode({
        directory: {
          workspace: "example",
          kind: "teams",
          items: [{ id: "71000000-0000-4000-8000-000000000003", title: "Engineering" }],
          hasMore: false,
          coverage: "API name lookup, not full text.",
        },
      }),
    );
  else
    console.log(
      encode({
        resource: {
          workspace: "example",
          kind: "teams",
          data: JSON.stringify({
            id: process.argv[5],
            name: "Engineering",
            description: "Complete team card",
          }),
        },
      }),
    );
  process.exit(0);
}
if (group === "auth" && action === "login") {
  console.log("auth: Linear MCP OAuth already authorized");
} else if (group === "comments" && action === "list") {
  console.log(
    encode({
      comments: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          body: existsSync("comment-body.txt")
            ? readFileSync("comment-body.txt", "utf8")
            : "Original comment",
          issueId: "11111111-1111-4111-8111-111111111111",
        },
      ],
      hasNextPage: false,
    }),
  );
} else if (group === "issues" && action === "view" && flag === "--full") {
  if (source === "ENG-13") {
    console.error("error: OAuth authorization required; Bearer private-fixture-token");
    console.error("help[1]:\n  Run `linear-axi auth login` to authorize");
    process.exitCode = 1;
  } else if (source === "ENG-12") {
    console.log(
      [
        "issue:",
        "  id: ENG-12",
        "  uuid: 11111111-1111-4111-8111-111111111111",
        '  title: "[0.3] Fixture: task"',
        "  url: https://linear.app/example/issue/ENG-12/fixture-task",
        "  description: " + JSON.stringify("First line\n\nSecond line"),
        "  project: Fixture project",
        "  team: ENG",
        "  status: In Progress",
        "  attachments[1]{id,title,url}:",
        "    attachment-id,A pull request,https://example.org/pull/1",
        "  documents[1]{id,title}:",
        "    71000000-0000-4000-8000-000000000006,Original request",
      ].join("\n"),
    );
  }
} else if (group === "documents" && action === "view" && flag === "--full") {
  console.log(
    [
      "document:",
      "  id: 71000000-0000-4000-8000-000000000006",
      "  title: Original request",
      "  content: " +
        JSON.stringify(
          existsSync(".pi/fixture-changed")
            ? "Changed source\nLast line"
            : "Full document\n\nLast line",
        ),
      "  url: https://linear.app/example/document/original-request-1234abcd5678",
    ].join("\n"),
  );
} else if (group === "teams" && action === "view" && source === "ENG" && flag === "--full") {
  console.log(
    encode({ team: { id: "team-id", key: "ENG", name: "Engineering", visibility: "public" } }),
  );
} else if (group === "issues" && action === "list") {
  const continued = process.argv.includes("--cursor");
  console.log(
    encode({
      count: continued ? 1 : "1 returned (more available)",
      ...(continued ? {} : { cursor: "next/page" }),
      issues: [
        {
          id: "ENG-12",
          title: "Fixture task",
          url: "https://linear.app/example/issue/ENG-12/fixture-task",
          teamId: "team-id",
          status: "In Progress",
        },
      ],
    }),
  );
} else if (group === "projects" && action === "list") {
  console.log(
    encode({
      count: 1,
      projects: [
        {
          id: "project-id",
          name: "Fixture project",
          url: "https://linear.app/example/project/fixture-ab12cd34ef56",
          status: "In Progress",
          teams: JSON.stringify([{ id: "team-id", key: "ENG" }]),
        },
      ],
    }),
  );
} else if (
  group === "projects" &&
  action === "view" &&
  source === "ab12cd34ef56" &&
  flag === "--full"
) {
  console.log(
    encode({
      project: {
        id: "project-id",
        name: "Fixture project",
        url: "https://linear.app/example/project/fixture-ab12cd34ef56",
        description: "Full description\nLast description line",
        status: { name: "In Progress" },
        resourceCount: 1,
        resources: [
          {
            type: "document",
            title: "Original request",
            url: "https://linear.app/example/document/original-request-1234abcd5678",
          },
        ],
      },
    }),
  );
} else {
  throw new Error("Unexpected CLI operation");
}
