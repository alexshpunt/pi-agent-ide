# `pi-agent-web-html`

## Purpose

`pi-agent-web-html` installs HTML and XHTML conversion for the web read provider.

The local converter owns format recognition, strict decoding, Defuddle extraction, final-source URL handling, and a plain-text fallback. Defuddle async extractors are disabled, so conversion performs no source I/O.

HTTP fetching, redirects, access policy, and response acquisition remain in `pi-agent-web`. The adapter only connects the converter to the `web/read` content target.
