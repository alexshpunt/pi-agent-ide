# `pi-agent-web-html`

## Purpose

`pi-agent-web-html` installs HTML and XHTML conversion for the web read provider.

The local converter owns format recognition, strict decoding, Defuddle extraction, final-source URL handling, and a plain-text fallback. It gives the parsed document the final page location before Defuddle runs, so relative canonical metadata is resolved without writing warnings or stack traces to Pi's terminal. Defuddle async extractors are disabled, so conversion performs no source I/O.

HTTP fetching, browser rendering, redirects, access policy, and response acquisition remain in `pi-agent-web`. Browser-rendered HTML has already had computed-hidden elements removed before this converter receives it. The adapter only connects the converter to the `web/read` content target.
