# `pi-agent-web`

## Purpose

`pi-agent-web` provides read-only HTTP(S) Resources to the generic `read` tool.

The provider owns URL recognition, HTTP access, redirects, headers, timeout, status handling, and response-byte acquisition. It does not parse concrete content formats.

## Target

The extension creates one local content host:

```text
web/read -> read-only Resource -> pi-agent-read
```

Production adapters install converters in this order:

```text
image -> pdf/html -> text
```

Lower priority runs first. The provider has no converter registry outside this host.

## Source recognition

The resolver handles valid `http:` and `https:` URLs. Other schemes return `not-handled`.

A malformed source that starts with an HTTP(S) scheme returns `failed`. Resolution performs no network request.

The resolver ID and read plugin ID are `web`.

## Read

A Resource read:

1. combines caller cancellation with a 30-second timeout;
2. performs one GET with browser-like headers;
3. follows redirects;
4. rejects non-success status codes;
5. reads the response body once as bytes;
6. sends the final response URL, bytes, and Content-Type to `web/read`;
7. returns the selected converter's AgentContent unchanged.

The final response URL lets HTML conversion resolve relative links after redirects.

The Resource has `read` and no `write` callback. This version adds no response byte limit.

The web resolver enables temporary snapshots. If the final converted and presented text is automatically truncated, the read result includes a `temp:<id>` source for the complete final text.

## Enabled formats

- `pi-agent-web-image` installs shared `pi-agent-image` conversion for supported raster images.
- `pi-agent-web-pdf` installs shared `pi-agent-pdf` conversion for PDF documents.
- `pi-agent-web-html` owns and installs local HTML and XHTML to Markdown conversion.
- `pi-agent-web-text` installs shared `pi-agent-text` conversion as the strict UTF-8 fallback.

Converters perform no network I/O. Defuddle async extractors are disabled so HTML conversion cannot fetch another source.

## Read prompt

The provider registers one lazy read description. It takes the current `web/read` converter snapshot and lists each installed type below the HTTP(S) provider summary in conversion order.

If no web content adapter is installed, the provider is omitted from the read prompt. This metadata reports installed behavior; it does not grant network access, activate a converter, or change resolver selection.

## Registration

The provider connects to `pi-agent-read` through its public plugin protocol. Content adapters connect through `pi-agent-resource`.

Provider-first and adapter-first loading are supported. Pi events are used only during registration; a Resource read invokes its local host directly.

Open limitations are listed in [`known-gaps.md`](./known-gaps.md).
