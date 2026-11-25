# Open GitHub API resources

Use this interface when a dedicated card or editor does not cover the resource. It uses the same selected connection, not another account.

## Read a REST resource

```js
await tools.read({ path: "https://api.github.com/repos/owner/repo/deployments" });
```

Read displays the response, original-byte link and API/browser links. Follow the exact next-page link. Do not treat an incomplete page as complete coverage. Search an API resource or an unchanged Read selection to match only that text; it does not search every linked object.

Pass a commit filter such as `actions/runs?head_sha=` the full 40-character SHA. A short SHA matches nothing and returns an empty list, not an error.

Use `raw:` with a byte offset and limit to read original bytes. A binary metadata card is not archive extraction or OCR.
Text responses are limited to 2 MiB and binary downloads to 25 MiB. Normal presentation redacts signed URL query credentials. Original-byte Read preserves them, so do not paste raw output into public artifacts.

## Send REST through Write

Read `github://api/rest` for the request schema, then Write JSON:

```js
await tools.write({
  path: "github://api/rest",
  content: JSON.stringify({
    method: "PATCH",
    path: "/repos/owner/repo/issues/17",
    body: { title: "New title" },
  }),
});
```

Use an API path or an exact `https://api.github.com/` URL. Omit body for GET/HEAD. Omit accept for GitHub JSON; use the endpoint's documented media type when requesting another representation. Encode URL query values. Do not supply credentials or authorization headers.

## Send GraphQL through Write

Read `github://api/graphql` for the schema. Supply query, optional variables and optional operationName:

```js
await tools.write({
  path: "github://api/graphql",
  content: JSON.stringify({
    query:
      "query View($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner url}}",
    variables: { owner: "owner", name: "repo" },
    operationName: "View",
  }),
});
```

Queries and mutations use the same request resource. A POST is not proof that the GraphQL operation changed something. Inspect GraphQL errors and partial results before deciding what happened.

## Read the response before another change

Write returns status and a `github://api/results/<id>` resource. Read or Search that exact link; use `raw:` for its original bytes. A completed request is not proof that every business-level operation succeeded. Reread the target after changing it.

Response snapshots are readonly and session-owned. Reload/shutdown retires them, and bounded storage can evict old responses. An expired response fails rather than replaying the request. Keep returned object identities for recovery.

## YOLO means no transport approval

Raw REST and GraphQL have no per-request confirmation in either mode, including headless mutations and DELETE. They can bypass IDE mode's confirmations on typed merge/review/release routes. Standalone skips typed confirmations too. Use these requests intentionally; ask the user before destructive work. The transport is not a policy firewall.

Selected-token permissions, trusted hosts, request/response bounds and cancellation still apply. Do not change access or use another profile to work around denial. Never automatically replay an unknown mutation effect.

Next: [Resource context](docs:github-context), [Coverage index](docs:github-coverage), [Access](docs:github-access).
