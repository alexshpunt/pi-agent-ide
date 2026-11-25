# Files and artifacts

Repository files use an explicit file resource with ref and path query parameters, or a verified browser blob/tree link. Use a commit SHA when a stable revision matters. Browser refs containing slashes are resolved from API evidence; ambiguous splits fail rather than being guessed. Friendly file views are bounded to 2 MiB. Binary files expose an original-byte link instead of fake UTF-8 text; prefix the displayed file resource with `raw:` for byte windows.

Release assets are separate original-byte resources. Read a returned asset link; raw: on that resource selects original bytes. Available text/images can be presented directly; unsupported binary formats remain explicit. No OCR or archive expansion is performed.

Upload through Write at a displayed release asset creation address. Read its schema and supply an explicit local regular file, asset name and optional content type. Uploads preserve bytes and are bounded at 25 MiB. Uploading to a published release uses the shared approval policy in IDE mode; standalone does not ask for confirmation. Read [Access](docs:github-access) for the mode-specific rules. Creating or publishing a release is separate from storing bytes.

Only documented GitHub storage endpoints are used. Browser issue/comment attachment uploads are not emulated with undocumented APIs or stored somewhere else as a fake success. Keep the returned asset identity. An unknown upload can already have stored bytes: inspect rather than retry or delete.
