# Linear: choose a guide

Use the ordinary resource tools when Pi Agent IDE is loaded. Without the IDE extension, discover the dedicated Linear tools through tool_search. Keep the installed pi-agent-ide SDK dependency in both modes.

The domain-guide examples use ordinary tool names. In standalone mode, use linear_read, linear_search, linear_write, linear_replace, linear_insert, linear_delete, linear_copy and linear_move for the corresponding operation. Keep linear_upload unchanged.

In Codemode with the IDE, a successful text Read of a Linear resource returns `{ text, id }`. Use `value.text` to inspect it, and pass `value` or `value.id` to another IDE tool to select the same text. A failed IDE Read returns `null`; the Codemode result lists the failure. Linear semantic actions may return their own structured receipts; inspect their effect before continuing. A creation link can appear in the Codemode result instead of the script value. These values do not describe the standalone tools.

Use an explicit resource path in standalone calls. Use linear_read with offset/limit and views: ["anchors"] for bounded text reads. Use the returned line#hash anchors or unique exact text for edits; do not pass IDE RESULT#/SEARCH# handles. Writing a field such as #status, #assignee or #delegate needs no prior Read. Read a body before editing it so your line#hash anchors or exact text match, and read again after each mutation. Standalone Copy links a document reference and Move renames a document; neither transfers arbitrary text ranges or filesystem objects.

Start from the user's URL, or use Search to find an object. Read returned links rather than inventing identities.

Read only the guide needed for the current task:

| Task                                                                 | Guide                                              |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| Find objects, list tasks by status or label, or search selected text | [Discovery](docs:linear-discovery)                 |
| Work with tasks, child tasks or their fields                         | [Issues](docs:linear-issues)                       |
| Store project-linked feedback or link it to Triage                   | [Customer Requests](docs:linear-customer-requests) |
| Create or manage a project                                           | [Projects](docs:linear-projects)                   |
| Create, edit or rename a text artifact                               | [Documents](docs:linear-documents)                 |
| Read or change a discussion                                          | [Discussions](docs:linear-discussions)             |
| Attach, upload, read or replace a file                               | [Files](docs:linear-files)                         |
| Work with teams, users, labels, cycles or templates                  | [Organization](docs:linear-organization)           |
| Work with releases, release notes or status updates                  | [Releases](docs:linear-releases)                   |
| Work with notifications or backend agent guidance                    | [Activity](docs:linear-activity)                   |
| Native Agent Skills or managed template content                      | [Workflow](docs:linear-workflow)                   |
| Read a diff or perform a review action                               | [Review](docs:linear-review)                       |
| Resolve access problems or an uncertain result                       | [Access and recovery](docs:linear-access)          |
| Use an API capability absent from typed resources                    | [Raw GraphQL](docs:linear-api)                     |

For example:

```js
await tools.read({ path: "docs:linear-projects" });
```

This entry guide is navigation, not the full operation catalog. Domain guides explain their own resources and direct you to the supported actions of a selected object. Do not load every guide in advance.

Keep linked bodies lazy: a card lists links, not the contents of every attachment or comment. Search inside each resource separately. A field fragment such as `#status` is distinct from its card or description.

An advertised operation does not prove permission to perform it. Typed high-risk actions use the shared dialog/session/YOLO policy in IDE mode and always require interactive confirmation in standalone mode. Raw GraphQL is an explicit exception: it has no per-request confirmation, even headless, and can bypass typed-route gates. Read [Raw GraphQL](docs:linear-api) when a needed capability is absent from the typed interface. Neither mode bypasses authorization or validation, and the agent still asks before destructive work. Read [Access](docs:linear-access) and never replay an uncertain mutation.
