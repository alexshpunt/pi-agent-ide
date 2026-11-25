# Linear discovery and text search

Use API discovery to find objects. Use text Search only after choosing the resource whose text matters.

## Find an object

Use `linear:<kind> <terms>` with an explicit workspace:

```js
await tools.search({ query: "linear:issues login", path: "linear://your-workspace", limit: 10 });
await tools.search({ query: "linear:projects website", path: "linear://your-workspace" });
await tools.search({ query: "linear:documents Workpad", path: "linear://your-workspace" });
await tools.search({ query: "linear:teams ENG", path: "linear://your-workspace" });
```

Take the workspace from the user's URL. Read a returned object's exact link. Discovery returns identities, not every matching object's body.

Issues, projects and documents use Linear's native GraphQL matching and ranking, including comments. A comment can make an issue match even when the term is absent from its card.

Teams and other directory kinds use their actual query, name or list operations. These are not universal full-text search. Cycles and statuses need a team scope; milestones need a project. Read [Organization](docs:linear-organization) for those resources.

A team URL, native project URL, or stable `linear://<workspace>/project/<UUID>` resource constrains supported discovery. The project is verified before searching; continuation links keep that exact scope. Use the project card itself, not a description or field link. Native issue filters are hard constraints. Project/document scope can require post-filtering; the reported total can precede filtering. An empty filtered page may still have a next page.

### Filter issues by project milestone

Add a `milestone` query parameter to a project scope. Its value can be a milestone UUID, an exact name (case-insensitive), or a discovered `linear://<workspace>/resource/milestones/<UUID>?parent=<project-UUID>` resource. Encode the value with `URL.searchParams`:

```js
const scope = new URL("linear://your-workspace/project/<project-UUID>");
scope.searchParams.set("milestone", "0.8.2 - Release");
await tools.search({ query: "linear:issues release", path: scope.href });
```

Discover milestones with `linear:milestones <name>` in the same project first. The issue search verifies that the milestone belongs to that project, then sends both UUID constraints to Linear's native search API. Text and comment matching still apply; a non-empty search term is required. All matching issue statuses are included.

Follow the exact returned continuation with Read. Each page retains the selected project and resolved milestone UUID, including empty pages. Unknown, ambiguous, foreign or incomplete milestone lookups fail before issue search. Milestone filtering requires project-scoped issue discovery; it does not apply to workspace, team, child-issue or document discovery.

For direct child issues, use the verified parent issue as the discovery scope. This searches child objects, not the parent's description. Read [Issues](docs:linear-issues) before changing parent relationships.

## List issues by status, label or priority

`linear:issues` is a text search: it needs a search term and accepts no status, label or priority filter. A scope such as `?status=Backlog` fails with `LINEAR_INVALID_SEARCH_SCOPE`; the only query parameter a project scope accepts is `milestone`. To list the open tasks of a project, the backlog of a team or the tasks with a label, send one filtered GraphQL query through [Raw GraphQL](docs:linear-api) and page through it with its cursor:

```js
const query = `query Backlog($project: ID!, $after: String) {
  issues(
    first: 100
    after: $after
    filter: {
      project: { id: { eq: $project } }
      state: { type: { in: ["triage", "backlog", "unstarted", "started"] } }
    }
  ) {
    nodes { identifier title priority state { name type } createdAt }
    pageInfo { hasNextPage endCursor }
  }
}`;
await tools.write({
  path: "linear://your-workspace/api/graphql",
  content: JSON.stringify({
    query,
    variables: { project: "<project-UUID>" },
    operationName: "Backlog",
  }),
});
```

Read the returned response resource. While `pageInfo.hasNextPage` is true, send the same query with `after` set to `pageInfo.endCursor`; keep the filter unchanged between pages. A page holds at most 250 issues, so a project of a few hundred open tasks takes a few requests. Status types are `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled` and `duplicate`; a type matches the same category in every team, whatever its statuses are named. `filter` also takes `team`, `assignee`, `labels` and `cycle`; the `issues` argument `includeArchived: true` adds archived issues. In standalone mode send the same request with `linear_write` to that path. The query's complexity is about the page size times the fields you request and must stay under 10,000 points, so ask only for the fields you need.

Never list tasks by reading identifiers one at a time, such as `ENG-1` to `ENG-1800`. That sends hundreds of requests, most of them for tasks that do not exist or that you do not need, and Linear's rate limit then locks every session on the connection out for an hour. If a filter you need does not exist, say so and ask; do not try parameters at random.

## Search selected text

```js
await tools.search({ query: "SSH", wholeWord: true, path: issueUrl });
```

A plain query or `regex:` searches the selected resource's canonical readable text. It does not follow linked documents, attachments or comments. Select the discussion or attachment separately before searching it.

In IDE mode, pass an unchanged Read/Search result to Search to keep its exact range. A displayed preview does not widen that range. Shared `SEARCH#` and `RESULT#` references verify fresh source content and expire when their session or snapshot changes.

In standalone mode, use linear_search with an explicit resource path. It accepts API discovery, literal text, regex, caseSensitive and wholeWord, without IDE result handles. Use linear_read to inspect the relevant body window and its own anchors before an edit. Do not assume that reading a card also read its linked body.

Text matching supports case sensitivity, whole words and regex. Glob filters and LSP navigation are not Linear text operations. Text is bounded to 2 MiB; regex work has a two-second limit. Failure or timeout is not zero matches.

## Continue rather than guess

Read an exact displayed next-page URL. Do not edit its cursor. Read's line offset is not API pagination. Incomplete coverage cannot prove that a word or object is absent.

Unsupported scope combinations, wrong workspaces and inaccessible resources fail explicitly. Public Linear developer/documentation URLs use the web provider. There is no global crawl, persistent content index, OCR or archive extraction.

## Inspect structured JSON with jq

In IDE mode, apply one `jq:<filter>` view to a structured card, typed field, directory object or returned API page:

```js
await tools.read({ path: issueUrl, views: ["jq:.id"] });
await tools.read({ path: `${issueUrl}#priority`, views: ["jq:."] });
```

The input is the structured value already acquired for that resource, not JSON scraped from its Markdown presentation. Scalars keep their types: a numeric field is a JSON number, an explicit `null` stays `null`, and a label field is an array. Schema/action resources and attachment metadata also support jq. Body text, downloaded assets and native images do not, even when their text resembles JSON.

A filter can return zero, one or several JSON values. `offset` and `limit` select transformed output lines; they do not skip input items or request another API page. Filtering a page does not fetch more pages or linked bodies. The API coverage and continuation notice remains outside the filtered JSON, even when the filter removes its pagination fields. Follow an exact returned continuation URL to acquire another page.

Use exactly one non-empty jq view without other annotation views. Malformed filters, missing jq, unsupported content and execution failures fail explicitly; they do not return an unfiltered card as success. The shared executor requires jq on the controller PATH, disables module loading, and limits execution to five seconds and 10 MiB of output. See [JSON reading](docs:json-reading) for filter syntax and temporary output handling.

Jq output is read-only derived data. It grants no source anchors or edit targets, including for the identity filter. Read the original resource without jq to get anchors. Jq on a bounded Read/Search result or a generic text anchor is refused rather than run against unseen JSON. A resource-owned semantic field such as `#priority` remains supported.

Standalone `linear_read` does not support jq. Use ordinary text/anchor reads there.

Next: [Issues](docs:linear-issues), [Documents](docs:linear-documents), [Discussions](docs:linear-discussions) or [Files](docs:linear-files), depending on the selected resource.
