# Read plugin prompt contributions

## Purpose

A read plugin may describe behavior that is not visible from the base `read` tool definition. Core aggregates accepted descriptions into one section:

```markdown
# Read Extensions

- `example-source` — Reads example source references.
  - `example-image` — Example images.
  - `example-text` — Example text.
- `example-presentation` — Adds configured presentation to textual results.
```

The IDs and descriptions above are fictional examples. Prompt metadata informs the agent about installed behavior. It does not activate `read`, grant permission, select a resolver, or execute a handler.

## Declaration

A plugin declares at most one description through the flat read API. The source may be a static string or a lazy renderer:

```ts
type PromptDescriptionSource = string | (() => string | undefined);

const plugin: ReadPlugin = {
  protocol: READ_PROTOCOL,
  apiVersion: READ_API_VERSION,
  id: "example-source",
  setup(api) {
    api.describe(() => currentDescription());
  },
};
```

Calls made during setup participate in its atomic transaction. Calls made through a retained API after commit update the live registry immediately.

A lazy renderer is stored without being called. Core calls it once for each active prompt snapshot. Returning `undefined` omits that plugin from the snapshot. The next snapshot evaluates the renderer again, so it can reflect the current installed extension graph without push notifications.

## Validation

Core requires:

1. non-empty description text;
2. normalized `\n` line endings;
3. removed surrounding blank lines and trailing whitespace;
4. at most one description source from one plugin.

A static string is normalized during registration. A lazy result is normalized when the prompt snapshot is built. A non-string result or a thrown error fails prompt construction. Core does not silently hide an invalid extension.

Descriptions are trusted extension-provided prompt content. They must not contain secrets, volatile credentials, top-level headings, or unrelated global instructions.

## Active-tool filtering

The section is omitted when `read` is inactive or when no active plugin returns a description. Lazy renderers are not called while `read` is inactive. Changes appear in the next `before_agent_start` snapshot and do not alter an in-flight prompt.

## Rendering

Plugin entries follow accepted registration order. Rendering:

- keeps one entry after idempotent delivery retries;
- renders plugin IDs as inline code;
- places the first description line after an em dash;
- indents continuation lines by two spaces;
- escapes inline-code delimiters in IDs;
- omits rejected, incomplete, and intentionally empty lazy contributions.

A provider can return its summary on the first line and child content types on following list lines. Core supplies the provider ID and indentation.

The Pi adapter waits for pending plugin setup, renders one snapshot, and appends it to the chained system prompt. Runtime read execution does not depend on prompt rendering.

## Testing contract

Black-box tests inspect the system prompt delivered to the scripted provider. They verify lazy snapshots, installed child content types, deterministic order, active-tool filtering, and one read-owned section heading.
