import { encode } from "@toon-format/toon-v4";
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const [group, action, source] = args;
if (group === "auth" && action === "epoch") {
  console.log(JSON.stringify({ epoch: "legacy", state: "legacy" }));
  process.exit(0);
}
const value = (key) => args[args.indexOf(key) + 1];
const project = {
  id: "P-ENG-1",
  uuid: "71000000-0000-4000-8000-000000000001",
  name: "Empty project",
  url: "https://linear.app/example/project/empty-cde012345678",
  description: null,
  resourceCount: 0,
};
appendFileSync("axi-calls.jsonl", JSON.stringify(args) + "\n");
const output = (data) => console.log(encode(data));

if (group === "projects" && action === "view") {
  if (![project.uuid, "cde012345678"].includes(source))
    throw new Error("Unexpected project identity");
  output({ project });
} else if (group === "resources" && action === "capabilities") {
  output({
    capabilities: {
      workspace: value("--workspace"),
      items: [{
        name: "get_project",
        inputSchema: JSON.stringify({
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        }),
        annotations: "{}",
      }],
    },
  });
} else if (group === "resources" && action === "invoke" && source === "get_project") {
  const input = JSON.parse(readFileSync(value("--input-file"), "utf8"));
  if (input.query !== project.uuid) throw new Error("Unexpected stable project identity");
  output({
    invocation: {
      workspace: value("--workspace"),
      operation: source,
      effect: "applied",
      data: JSON.stringify(project),
    },
  });
} else if (group === "resources" && action === "scope") {
  // Scoped object search verifies its parent project through this internal command.
  const [kind, reference] = args.slice(2);
  if (kind !== "project" || ![project.uuid, "cde012345678", "empty-cde012345678"].includes(reference))
    throw new Error("Unexpected search scope");
  output({ project: { id: project.uuid, url: project.url } });
} else if (group === "search" && action === "issues") {
  const rows = [
    {
      id: "ENG-12",
      title: "Scope bug in selected project",
      url: "https://linear.app/example/issue/ENG-12/scope-bug",
      projectId: project.uuid,
    },
    {
      id: "ENG-13",
      title: "Scope bug on the next page",
      url: "https://linear.app/example/issue/ENG-13/next-scope-bug",
      projectId: project.uuid,
    },
    {
      id: "ENG-99",
      title: "Scope bug outside selected project",
      url: "https://linear.app/example/issue/ENG-99/foreign-scope-bug",
      projectId: "71000000-0000-4000-8000-000000000002",
    },
  ];
  const filtered = args.includes("--project-id")
    ? rows.filter((row) => row.projectId === value("--project-id"))
    : rows;
  const continued = args.includes("--cursor");
  const items = continued ? filtered.slice(1) : filtered.slice(0, 1);
  output({
    search: {
      kind: action,
      workspace: value("--workspace"),
      term: value("--query"),
      items,
      hasMore: !continued,
      ...(!continued ? { cursor: "next/page" } : {}),
      totalCount: filtered.length,
      postFiltered: false,
    },
  });
} else {
  throw new Error("Unexpected CLI operation");
}
