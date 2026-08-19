# Known gaps

## Response size

Web reads currently have no response byte limit. A large response can consume substantial memory before conversion.

This gap is closed when a source-level limit is required and its failure behavior is defined.

## Additional formats

Production adapters currently enable UTF-8 text, HTML, PDF text extraction, JPEG, static PNG, GIF, WebP, and BMP.

SVG conversion, office documents, ebooks, audio, and video are not supported. Each future format belongs in an independent type package and selected provider adapters.

## Request policy

The production provider performs an unauthenticated GET with fixed headers and a 30-second timeout. It has no cookie, custom-header, or authentication configuration.

A separate provider can implement another HTTP access policy without changing the read core or type packages.
