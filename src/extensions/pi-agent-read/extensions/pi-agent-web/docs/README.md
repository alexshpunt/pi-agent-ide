# `pi-agent-web`

## Purpose

`pi-agent-web` provides read-only HTTP(S) Resources to the generic `read` tool.

The provider owns URL recognition, direct HTTP access, browser rendering, redirects, headers, timeout, status handling, and response-byte acquisition. It does not parse concrete content formats.

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

The `web` resolver handles valid `http:` and `https:` URLs. Browser rendering is internal, not a separate source protocol. Other schemes return `not-handled`.

A malformed claimed source returns `failed`. Resolution performs no network request or browser launch. The resolver and renderer ID is `web`.

## Direct read

A normal HTTP(S) Resource read:

1. combines caller cancellation with a 30-second timeout;
2. performs one GET with browser-like headers;
3. follows redirects and rejects non-success status codes;
4. reads the response body once as bytes;
5. sends the final response URL, bytes, and Content-Type to `web/read`;
6. returns the selected converter's AgentContent unchanged.

Failed requests (including HTTP errors, network errors, and timeouts), failed HTML conversion, and empty HTML trigger one automatic browser retry in the same read call. The retry gets a fresh timeout and keeps caller cancellation. Non-HTML conversion errors are preserved. If the browser fails or returns empty content, the read reports both failures.

## Browser read

Automatic fallback loads the original URL in system Chrome or Chromium through Playwright. The browser waits for DOM content and a short best-effort network-idle window, removes DOM elements hidden by HTML or computed CSS, then sends the rendered HTML and final page URL to `web/read`.

Discovery checks `PI_AGENT_IDE_BROWSER_PATH`, browser commands on `PATH`, and common Linux install locations. A missing or invalid executable returns an actionable read failure. The doctor reports missing browser support as a warning because direct web reads still work.

Browser reads execute untrusted page JavaScript. Chromium runs without its process sandbox, including when Pi runs as root. This is an explicitly accepted runtime policy for this project; callers should use browser reads only for trusted sources.

## Shared behavior

The final response URL lets HTML conversion resolve relative links after redirects. Resources have `read` and no `write` callback. This version adds no response byte limit.

The web resolver enables temporary snapshots. If the final converted and presented text is automatically truncated, the read result includes a `temp:<id>` source for the complete final text.

## Enabled formats

- `pi-agent-web-image` installs shared `pi-agent-image` conversion for supported raster images.
- `pi-agent-web-pdf` installs shared `pi-agent-pdf` conversion for PDF documents.
- `pi-agent-web-html` owns and installs local HTML and XHTML to Markdown conversion.
- `pi-agent-web-text` installs shared `pi-agent-text` conversion as the strict UTF-8 fallback.

Converters perform no network I/O. Defuddle async extractors are disabled so HTML conversion cannot fetch another source.

## Read prompt

The provider registers one lazy read description. It describes plain HTTP(S) URLs and automatic fallback, then takes the current `web/read` converter snapshot and lists each installed type in conversion order.

If no web content adapter is installed, the provider is omitted from the read prompt. This metadata reports installed behavior; it does not grant network access, activate a converter, or change resolver selection.

## Registration

The provider connects to `pi-agent-read` through its public plugin protocol and contributes its optional runtime check to `pi-agent-doctor`. Content adapters connect through `pi-agent-resource`.

Provider-first and adapter-first loading are supported. Pi events are used only during registration; a Resource read invokes its local host directly.
