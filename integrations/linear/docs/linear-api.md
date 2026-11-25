# Linear GraphQL through Write

Use GraphQL when the Linear API supports a capability missing from the typed resources. This is a trusted raw interface, not a separate tool family.

The most common such capability is listing tasks by status, label, assignee or priority, which `linear:issues` search cannot filter. One `issues(filter: …, first: 100, after: …)` query with cursor paging does it in a few requests; the example is in [Discovery](docs:linear-discovery#list-issues-by-status-label-or-priority). Never read tasks one by one to build a list.

## Request

Read `linear://<workspace>/api` or `linear://<workspace>/api/graphql` for the request schema. Submit JSON with ordinary Write:

```json
{
  "query": "query SelectedIssue($id: String!) { issue(id: $id) { id title } }",
  "variables": { "id": "ENG-752" },
  "operationName": "SelectedIssue"
}
```

The same address accepts query and mutation documents. Multiple operations require an unambiguous `operationName`. Invalid syntax or selection is rejected before dispatch. Subscriptions are not supported. Requests and responses are bounded; inspect the advertised limits.

Requests use the current Linear connection and verified workspace at `https://api.linear.app/graphql`. Do not supply endpoints, headers, tokens, credentials or connection overrides. No permission expansion or personal-credential fallback occurs. Read-only schema discovery does not dispatch a GraphQL request.

## Confirmation policy

Raw GraphQL has **no per-request UI confirmation**, including headless mutations. It can bypass the confirmations on typed routes; those routes are not a security boundary for raw requests. The agent must still obtain user approval before destructive or externally visible work outside the authorized task. Existing typed-route confirmations remain unchanged.

## Response

Write returns a compact receipt and a response resource such as:

```text
linear://<workspace>/api/results/<UUID>
```

Read that returned resource to inspect HTTP status, operation type, `data`, `errors`, extensions and the reported outcome/effect. Search that response or an observed part of it through ordinary Search. This searches only the selected response, not the workspace. Another page requires an explicit GraphQL request; response links do not start a crawl.

HTTP success is not proof of business success. GraphQL can return partial data and errors with HTTP 200. Inspect the full result and reread the affected resource before claiming that the intended change occurred. A successful query has no mutation effect. An acknowledged raw mutation still requires checking its own returned fields and the saved object.

Responses are session-local, bounded to sixteen retained results and a 32 MiB store, and scoped to the working directory and connection. Old responses can be evicted; authorization/session changes invalidate them. Save needed evidence separately. Large bodies stay in the readable response resource rather than being duplicated into every Write receipt.

## Failure and recovery

Permission errors, rate limits, malformed responses, partial outcomes, cancellation and uncertain effects remain explicit. A `data: null` response can follow a committed mutation when another field fails; it does not prove that nothing changed. An applied effect with a later failure keeps its applied status. Raw mutations are never automatically replayed, including after a connection failure or timeout. When the result is uncertain, inspect the target using its known identity. Supplying a known fixture UUID where the API permits it can make recovery easier. If the effect cannot be established, report the uncertainty instead of submitting the mutation again.

In standalone mode use `linear_read`, `linear_write` and `linear_search` with explicit paths. Their raw confirmation policy is the same; ordinary body edits and typed high-risk actions retain their existing rules.
