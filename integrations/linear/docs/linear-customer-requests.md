# Customer Requests and Triage

Use Customer Requests for project-linked feedback before it becomes a task. A request and an Issue are different records. Linking a request does not create an Issue or accept it from Triage.

## Store an idea

Read `linear://<workspace>/customers` to find an existing Customer. Read `linear://<workspace>/customer-requests?project=<project>` for that project's requests. Follow returned continuation links when the list is incomplete.

Read `linear://<workspace>/customer-request/new` for the live creation schema. Write a JSON object containing `body`, `customer` and `project`. Omit `issue` to create a project-only idea:

```js
await tools.write({
  path: `linear://${workspace}/customer-request/new`,
  content: JSON.stringify({ body: feedback, customer: customerId, project: projectId }),
});
```

Use the returned scoped Read link. Keep its `?project=...` query when reading or editing the request. The query identifies the lookup scope; it is not an instruction to move the request. Read `#body` for its text and `#fields` for editable values. Write to `#body` to update feedback. Customer creation and deletion are not exposed by this flow.

## Create a task for review

Read the team's issue statuses and the Issue creation schema. Create an Issue with the verified project, team and **Triage** state. Set priority, assignee, estimate and labels through the advertised Issue fields, either at creation or afterwards.

Then Write the returned Issue identifier or UUID to the existing request's `#issue` field. Keep the original request identity; do not create a second request. The Issue must belong to the same project.

Read both records to verify the association. A request card preserves its customer, project and Issue details. Use the separate Issue resource for current status and metadata.

## Leave acceptance to the user

Keep the Issue in Triage until the user presses Accept or Decline in Linear. Do not move it to backlog on the user's behalf as part of this flow. After the user acts, Read the same Issue's `#status` and the same request again. Accept uses the team's configured destination; do not assume its name is always Backlog.

This flow has no automatic waiter, webhook subscription or agent wake-up. A Read is an observation, not an approval or a promise to monitor later changes.

## Handle incomplete or uncertain results

The request-by-ID lookup searches only the selected project's API pages, up to five pages of 50 requests. An incomplete lookup is not proof that a request is absent. Use the paginated project list to inspect its scope; do not retry a creation because a lookup failed.

A failed or unknown mutation may have changed Linear. Read the same records before deciding what to do next. Do not replay an unknown save. Read [Access and recovery](docs:linear-access) for authorization and recovery rules.
