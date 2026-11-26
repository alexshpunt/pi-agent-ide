# pi-web-search

An optional Pi extension that searches the web and images through [Serper](https://serper.dev) and lets agents page through saved results with Pi Agent IDE's `Read` and `Search`. It provides `web_search`, `image_search` and `wait_for_web_searches`.

## Install

Run `pnpm install` at the IDE repository root to link workspace dependencies. Add the absolute path to `integrations/web-search` to Pi's `packages` in `settings.json`, then reload Pi. Do not load the standalone `pi-web-search` package alongside it: both register the same tools. Configure a Serper key using the `configure-web-search` skill. This integration is not published to npm.

Start Pi after installation. Pi loads the TypeScript package entrypoint in `index.ts`. The extension has no provider SDK or HTTP runtime dependency. Pi, Pi TUI, and TypeBox are peer dependencies. [Pi Agent IDE](https://github.com/alexshpunt/pi-agent-ide) is a dependency: it provides `Read` and `Search` for the `websearch:<id>` result resources, so install it next to this package. Background delivery uses Pi 1.0.2's actionable turn boundaries.

## Agent tool

Every `web_search` goes to Serper and nowhere else. When Serper fails, the tool returns Serper's own error, for example `Not enough credits`, and does not try another source. A Serper key comes from the first enabled `serper` entry in the configuration or from `SERPER_API_KEY`.

```json
{ "query": "Pi Search resolver architecture", "limit": 10 }
```

`query` must be a non-empty string. `limit` is optional, from 1 to 20, and defaults to 10. Serper returns about 10 web results per page and charges 1 credit per page, so a default search can cost 2 credits when the first page holds fewer than 10 results. The reply lists the results as a numbered list and names a `websearch:<id>` resource.

### Saved results

Each search saves its results as a `websearch:<id>` resource with one line per result, so a line number is a result number. With Pi Agent IDE loaded:

- `Read` with `offset` and `limit` shows more results. A read past the saved results fetches the missing Serper pages first. Reading results that are already saved costs nothing.
- `Search` with `path: "websearch:<id>"` finds text or URLs in the saved results. It searches only what is saved so far; `regex:<pattern>` is accepted.

The id comes from the tool call id. Resources live as long as the Pi process; after a restart, run the search again.

### Image search

`image_search` takes either a text `query` or an `image`, and an optional `limit` (1–100, default 10).

```json
{ "query": "eiffel tower at night", "limit": 10 }
```

A text query makes one Serper call for 100 images (2 credits), lists the first `limit` with title, image URL, thumbnail, source page and size, and saves all 100. `Read` pages through them without new calls; reading past 100 fetches the next 100 for another 2 credits. `Read` on an image URL from the results shows the image.

```json
{ "image": "https://example.com/photo.jpg" }
```

An `image` finds visually similar images and the pages that show them, through Serper Lens (3 credits). Lens returns every match in one call and takes only a public URL. A local file path is uploaded first, and the resulting URL goes to Serper. Without an account the upload goes to the anonymous host `litterbox.catbox.moe`, which deletes the copy after one hour; that is its shortest lifetime. With a [Catbox](https://catbox.moe) account hash, set as `catboxUserhash` in `websearch.json` or as `CATBOX_USERHASH`, the file is uploaded to that account and deleted again as soon as Lens has answered, even when Lens fails. Either way Serper and the file host see the image, so do not search by an image that shows secrets or private data. Only `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `avif` and `tiff` files up to 20 MB are uploaded.

Each snippet is rendered on one line as `Excerpt: “<text>”`. Markdown and HTML structure is removed, whitespace is collapsed, and unsafe terminal and bidirectional presentation controls are neutralized in snippets, titles and displayed URLs. The package does not summarize or truncate snippets.

## Background searches

`web_search` waits for the Serper result by default. Add `"background": true` to return a launch receipt immediately:

```json
{ "query": "Pi extension lifecycle", "limit": 5, "background": true }
```

The receipt contains `requestId`, `query`, and `status: "running"`. It is not search evidence. Launch several independent queries and continue unrelated work. The result or failure arrives when Serper answers. Active runs receive it at the next safe turn boundary; an idle agent wakes automatically. An in-flight model request is not rewritten.

The agent receives the results, the `websearch:<id>` resource, credits used, timing, and redacted diagnostics. The user sees a compact card with the query, status, duration, result count, and source domains. Expand the card for the pages; collapsing it never removes information from agent context.

In Stereo fullscreen, each delayed card appears in Activity beside the call that launched it, not in Conversation. Searches launched inside Codemode or another tool stay with their real visible outer call. Calls keep their own cards even when searches finish out of order. Late card text remains searchable, and saved history keeps its chronological order.

When no independent work remains, call `wait_for_web_searches` with `{}`. It waits for the next available batch from searches outstanding when the call starts and returns those results. Wait shows only a short consumption confirmation; the full cards remain at their original calls. Results already delivered automatically are not repeated. A later wait returns an empty `results` list once everything has been delivered. Searches launched after a wait starts belong to a later delivery.

Stopping the agent cancels outstanding searches. Reloading Pi, switching sessions, or navigating to another session branch interrupts them without restarting them or delivering old results into the new history. Jobs are not persisted across reloads.

Cancellation from Stop or a failed model turn saves one passive `web-search:cancelled` custom entry per outstanding request. Its data is `{ requestId, status: "cancelled", parentToolCallId? }`. Session-work consumers can release ownership from this receipt without starting another model turn. Session replacement and reload discard old runtime work without adding cancellation entries to the replacement history.

## Other providers and native search

Only Serper runs. The code for the other providers (Exa, Tavily, Brave, DuckDuckGo HTML, Parallel, Google CSE, Z.AI, OpenAI, Codex, Anthropic, Perplexity, xAI and Kimi), for aggregation and for native OpenAI Codex search stays in the package and in the configuration format, but no tool calls it, and it never changes a result. Serper was chosen as the cheapest source of real Google results that has an images endpoint and paging; revisit the choice after about six months of use.

## Configuration

The extension checks these files:

1. `<cwd>/.pi/websearch.json`
2. `~/.pi/agent/websearch.json`
3. built-in DuckDuckGo HTML defaults

A project file supplies the active configuration when present. Otherwise the global file does. The built-in default is used when neither exists. The default has no Serper entry, so set `SERPER_API_KEY` or add a `serper` entry. A present invalid file is an error; it is not silently skipped. Global and project entries can still supply credentials for matching provider IDs or provider names.

A configuration can use one external provider at the top level:

```json
{
  "provider": "serper",
  "maxResults": 10
}
```

Or it can define several external providers:

```json
{
  "maxResults": 10,
  "sourceTimeoutMs": 30000,
  "aggregateDeadlineMs": 45000,
  "providers": [{ "id": "primary", "provider": "serper" }, { "provider": "duckduckgo-html" }]
}
```

Only the first enabled `serper` entry is used, for its `apiKey` and `baseUrl`. Set `enabled` to `false` on it to disable Serper.

Top-level keys are `catboxUserhash`, `maxResults` (1–20), positive finite `sourceTimeoutMs`, positive finite `aggregateDeadlineMs`, and either `providers` or the fields for one provider. Provider fields are:

- `id`, `provider`, `enabled`, `apiKey`, `baseUrl`, `searchEngineId`, and `maxResults`;
- `model`, `codexMode` (`cached` or `live`), and `searchContextSize` (`low`, `medium`, or `high`);
- `allowedDomains` or `blockedDomains` (not both);
- `userLocation` with optional `country`, `region`, `city`, and `timezone`.

The old top-level `strategy`, `fallback`, and `providerOrder` fields and provider-level `priority` and `weight` fields are accepted only for migration. They do not change source selection, ordering, concurrency, or cost. The doctor command and structured search details warn until they are removed.

Provider-specific fields are sent only where that provider supports them. Google CSE also requires `searchEngineId`. All providers except DuckDuckGo HTML require credentials.

### Credentials

Credential precedence is:

1. environment;
2. matching provider in `~/.pi/agent/websearch.json`;
3. matching provider in `<cwd>/.pi/websearch.json`.

Supported standard environment names are:

- `EXA_API_KEY`
- `TAVILY_API_KEY`
- `BRAVE_SEARCH_API_KEY` or `BRAVE_API_KEY`
- `SERPER_API_KEY`
- `PARALLEL_API_KEY`
- `GOOGLE_API_KEY` and `GOOGLE_SEARCH_ENGINE_ID`
- `ZAI_API_KEY`
- `OPENAI_API_KEY` for OpenAI and Codex
- `ANTHROPIC_API_KEY`
- `PERPLEXITY_API_KEY`
- `XAI_API_KEY`
- `KIMI_API_KEY`

The retained legacy credential form is `PI_AGENT_IDE_SEARCH_<ID>_API_KEY`, where `<ID>` is the provider entry `id`, or the provider name when no ID is set. Non-alphanumeric characters become underscores and the name is uppercased. This legacy name is checked before the provider's standard environment name.

## Doctor command

Run `/pi-web-search-doctor` in Pi to check the search configuration for the active working directory. The command does not search, probe native-model capability, change configuration, or register another agent tool. It reports:

- `PASS` for loaded configuration, external providers with available credentials, and the Serper key that `web_search` and `image_search` need;
- `WARN` for obsolete routing fields or an external provider that is disabled or lacks credentials;
- `FAIL` for invalid JSON, provider configuration, limits, deadlines, or unsafe endpoints.

The report is redacted. It checks only whether an external credential is present and never prints its value.

## Public API

The public Pi extension entrypoint is the default export from `index.ts`. Loading it registers `web_search`, `image_search`, `wait_for_web_searches`, result-card rendering, and the user command `/pi-web-search-doctor`. The modules under `src/` are package-owned implementation details. The package ships one skill, `configure-web-search`, which explains how to set the Serper key. All other agent guidance is in the tool descriptions.

## Development checks

From the IDE repository, run the integration's focused tests and typecheck. The optional Stereo ownership cases use `PI_WEB_SEARCH_STEREO_EXTENSION` to point to a separate Stereo entrypoint.
