---
name: configure-web-search
description: Use when the user asks how to set up or change the Serper key or the Catbox hash for web_search or image_search, or when a search fails with "Serper is not configured".
---

# Configure web search

`web_search` and `image_search` use Serper only. Nothing else needs a key, and no other provider is ever tried.

## Set the key

Pick one place:

- the environment variable `SERPER_API_KEY`;
- `<cwd>/.pi/websearch.json` for one project, or `~/.pi/agent/websearch.json` for every project:

```json
{ "provider": "serper", "apiKey": "..." }
```

The project file wins over the global file as the active configuration. If neither exists, there is no Serper entry and no key unless the environment variable is set.

## Rules

- The environment variable beats the key in a file. When a key seems ignored, check `SERPER_API_KEY` first.
- Only the first enabled `serper` entry is used. `"enabled": false` turns it off, and `baseUrl` overrides the endpoint.
- A present but invalid `websearch.json` is an error, not a skipped file.
- Never print the key back to the user or write it into a tracked file. Keep it in the environment or in a git-ignored `.pi/websearch.json`.

## Catbox (local image search)

Serper Lens takes only a public URL, so `image_search` with a local file path uploads the file to Catbox first. A URL `image` needs no upload. The Catbox hash is not a Serper key and is optional.

- Without a hash, the file goes to the anonymous host `litterbox.catbox.moe` and is deleted after one hour, its shortest lifetime.
- With a [Catbox](https://catbox.moe) account hash, the file goes to that account and is deleted as soon as Lens answers, even when Lens fails. Set the hash as `CATBOX_USERHASH` or as `catboxUserhash` at the top level of `websearch.json`:

```json
{ "catboxUserhash": "...", "provider": "serper", "apiKey": "..." }
```

- `CATBOX_USERHASH` beats `catboxUserhash`; a project file beats the global file.
- Either way Serper and the file host see the image. Tell the user not to search by an image that shows secrets or private data.
- Only `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `avif` and `tiff` files up to 20 MB are uploaded.
- The hash is a credential for the account: treat it like the key above.

## Check

Ask the user to run `/pi-web-search-doctor` in Pi. It reports whether the Serper key is found, without printing it, and flags invalid configuration. It does not search, so it costs no credits.

Details: the Configuration and Credentials sections of the package README.
