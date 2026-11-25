import { encode } from "@toon-format/toon-v4";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ids = {
  project: "11111111-1111-4111-8111-111111111111",
  customer: "22222222-2222-4222-8222-222222222222",
  request: "33333333-3333-4333-8333-333333333333",
  issue: "44444444-4444-4444-8444-444444444444",
  user: "55555555-5555-4555-8555-555555555555",
  feature: "66666666-6666-4666-8666-666666666666",
};
const args = process.argv.slice(2);
const [group, action, operation] = args;
if (group === "auth" && action === "epoch") {
  console.log(JSON.stringify({ epoch: "legacy", state: "legacy" }));
  process.exit(0);
}
const value = (key) => args[args.indexOf(key) + 1];
const workspace = value("--workspace");
if (group !== "resources" || workspace !== "example") throw new Error("Unexpected CLI scope");
const file = "customer-pipeline-state.json";
const state = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : { requests: [], issue: null, calls: [] };
const project = {
  id: "P-ENG-1",
  uuid: ids.project,
  name: "Pipeline project",
  url: "https://linear.app/example/project/pipeline-123456789abc",
};
const customer = { id: ids.customer, name: "Test customer" };
const user = { id: ids.user, name: "Test owner" };
const string = { type: "string" };
const nullableString = { type: ["string", "null"] };
const strings = { type: "array", items: string };
const schemas = {
  list_customers: { limit: { type: "number", maximum: 250 } },
  list_customer_needs: { project: string, cursor: string, limit: { type: "number", maximum: 250 } },
  save_customer_need: { id: string, body: string, customer: string, project: string, issue: string, priority: { type: "number" } },
  get_project: { query: string },
  get_issue: { id: string },
  get_user: { query: string },
  list_issue_labels: { team: string, limit: { type: "number", maximum: 250 } },
  save_issue: {
    id: string,
    title: string,
    team: string,
    project: string,
    state: string,
    priority: { type: "integer" },
    assignee: nullableString,
    estimate: { type: ["number", "null"] },
    labels: strings,
    addLabels: strings,
    removeLabels: strings,
  },
};
const output = (data) => console.log(encode(data));
function requireIdentity(actual, expected) {
  if (!expected.includes(actual)) throw new Error("Unexpected resource identity");
}
function labelName(label) {
  return label === ids.feature ? "feature" : label;
}
function requestRow(request) {
  return {
    id: request.id,
    body: request.body,
    priority: request.priority,
    customer,
    project: { id: ids.project, name: project.name },
    ...(request.issue ? { issue: {
      id: state.issue.id,
      title: state.issue.title,
      state: { name: state.issue.status, type: state.issue.status === "Triage" ? "triage" : "backlog" },
    } } : {}),
  };
}

if (action === "capabilities") {
  output({ capabilities: {
    workspace,
    items: Object.entries(schemas).map(([name, properties]) => ({
      name,
      inputSchema: JSON.stringify({ type: "object", properties, additionalProperties: false }),
      annotations: JSON.stringify({ readOnlyHint: !name.startsWith("save_") }),
    })),
  } });
} else if (action === "invoke" && Object.hasOwn(schemas, operation)) {
  const input = JSON.parse(readFileSync(value("--input-file"), "utf8"));
  state.calls.push({ operation, input });
  let data;
  if (operation === "get_project") {
    requireIdentity(input.query, [ids.project, project.name]);
    data = project;
  } else if (operation === "list_customers") {
    data = { customers: [customer], hasNextPage: false };
  } else if (operation === "get_user") {
    requireIdentity(input.query, ["me", ids.user]);
    data = user;
  } else if (operation === "list_issue_labels") {
    data = { labels: [{ id: ids.feature, name: "feature" }], hasNextPage: false };
  } else if (operation === "list_customer_needs") {
    requireIdentity(input.project, [ids.project, project.name]);
    data = { customerNeeds: state.requests.map(requestRow), hasNextPage: false };
  } else if (operation === "save_customer_need") {
    if (input.id) {
      requireIdentity(input.id, [ids.request]);
      if (Object.hasOwn(input, "project")) throw new Error("Read scope must not reparent a request");
      const request = state.requests.find((row) => row.id === input.id);
      if (!request) throw new Error("Request missing");
      if (input.issue) {
        requireIdentity(input.issue, [ids.issue]);
        if (!state.issue) throw new Error("Issue missing");
        request.issue = input.issue;
      }
      if (Object.hasOwn(input, "body")) request.body = input.body;
    } else {
      requireIdentity(input.project, [ids.project]);
      requireIdentity(input.customer, [ids.customer]);
      if (state.requests.length || input.issue) throw new Error("Idea must be created once without an issue");
      state.requests.push({ id: ids.request, body: input.body, priority: input.priority ?? 0, issue: null });
    }
    data = requestRow(state.requests[0]);
  } else if (operation === "get_issue") {
    requireIdentity(input.id, ["ENG-12", ids.issue]);
    if (!state.issue) throw new Error("Issue missing");
    data = state.issue;
  } else if (operation === "save_issue") {
    if (!input.id) {
      if (state.issue || input.state !== "Triage") throw new Error("Create exactly one Triage issue");
      requireIdentity(input.project, [ids.project]);
      state.issue = {
        id: "ENG-12",
        uuid: ids.issue,
        title: input.title,
        team: input.team,
        projectId: ids.project,
        url: "https://linear.app/example/issue/ENG-12/customer-pipeline",
        status: input.state,
        priority: 0,
        assignee: null,
        estimate: null,
        labels: [],
      };
    } else {
      requireIdentity(input.id, [ids.issue]);
      if (Object.hasOwn(input, "state")) throw new Error("Accept belongs to the human, not the agent");
    }
    if (Object.hasOwn(input, "priority")) state.issue.priority = input.priority;
    if (Object.hasOwn(input, "assignee")) {
      if (input.assignee !== null) requireIdentity(input.assignee, [ids.user]);
      state.issue.assignee = input.assignee === null ? null : user.name;
      state.issue.assigneeId = input.assignee;
    }
    if (Object.hasOwn(input, "estimate")) state.issue.estimate = input.estimate;
    if (input.labels) state.issue.labels = input.labels.map(labelName);
    if (input.addLabels) state.issue.labels = [...new Set([...state.issue.labels, ...input.addLabels.map(labelName)])];
    if (input.removeLabels) state.issue.labels = state.issue.labels.filter((label) => !input.removeLabels.map(labelName).includes(label));
    data = state.issue;
  }
  writeFileSync(file, JSON.stringify(state, null, 2));
  output({ invocation: { workspace, operation, effect: "applied", data: JSON.stringify(data) } });
} else {
  throw new Error("Unexpected CLI operation");
}
