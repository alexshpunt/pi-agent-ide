# Byte-exact edit benchmark

Real models edit an ordinary-looking TypeScript file full of invisible characters, once with Pi's stock tools and once with the IDE's edit tools. Each final file is compared byte for byte with the expected file. Stock Pi is the baseline: a model that edits correctly with it shows that the task is fair, so an IDE failure on the same task points at the IDE tools.

The benchmark is separate from the Explicit Edit benchmark and from the [tool capability matrix](../tool-capabilities/README.md). It reuses the matrix's sandbox, credential staging and scheduler.

## Run

```bash
pnpm bench:byte-exact-edit --list        # variants and harnesses, no model calls
pnpm bench:byte-exact-edit --check       # deterministic self-check, no model calls
pnpm bench:byte-exact-edit --run --auth-dir /path/to/private-pi-auth
pnpm bench:byte-exact-edit --run --auth-dir /path/to/private-pi-auth \
  --models openai-codex/gpt-6-luna --harnesses stock,ide --variants bom --runs 1
```

No model calls occur without `--run`. With `--run` and no other options, the command runs every variant with both harnesses on `openai-codex/gpt-6-luna`, `openai-codex/gpt-5.6-luna` and `openai-codex/gpt-6.1-terra` at thinking `low`, two runs each: 48 runs, four at a time. It prints a table of passes per model, harness and variant, followed by one line per run, and exits with 1 unless every run passed. A run passes when its status is `ok` and its file passes.

| Option          | Default                               | Meaning                                 |
| --------------- | ------------------------------------- | --------------------------------------- |
| `--models`      | the three models above                | Comma-separated `provider/model` ids    |
| `--thinking`    | `low`                                 | Thinking level for every model          |
| `--harnesses`   | `stock,ide`                           | Which tool sets to run                  |
| `--variants`    | `mid,end,crlf,bom`                    | Which tasks to run                      |
| `--runs`        | `2`                                   | Runs of each model, harness and variant |
| `--concurrency` | `4`                                   | Runs at the same time                   |
| `--timeout`     | `300`                                 | Seconds per run                         |
| `--auth-dir`    | required                              | Private directory with a Pi `auth.json` |
| `--results`     | `.tmp/byte-exact-edit-results/<time>` | New directory for the results           |
| `--pi`          | `pi`                                  | Installed Pi to run                     |

Requirements are those of the matrix's paid runs: Linux or WSL, Node 24, Git, Bubblewrap with user namespaces, and an installed Pi under `/usr`, `/opt` or `~/.local`.

`--auth-dir` follows the matrix's snapshot mode. It must be a private copy, not `~/.pi/agent` itself. Each run gets only the selected provider's access token, without its refresh token, and the token must stay valid for the run's timeout plus Pi's five-minute refresh window. An account, quota or authentication error stops the remaining runs.

## The file

`fixtures.ts` generates a 75-line file, `routes.ts`, the same on every machine. It has a BOM, U+00A0 no-break spaces, U+200B zero-width spaces, a U+202F narrow no-break space, U+2060 word joiners and a U+00AD soft hyphen, a tab indent among space indents, trailing spaces and a trailing tab, CRLF on about a third of the lines and no line break at the end.

## Variants

Each variant gives the agent a short prose task that does not mention the invisible characters. The expected file is `file[:start] + replacement + file[end:]` for one span, so every byte outside the span stays as it was.

| Variant | Edit                                                                                        |
| ------- | ------------------------------------------------------------------------------------------- |
| `mid`   | Change `retries: 3` to `5` on line 40, which has U+00A0, U+200B and U+202F around the value |
| `end`   | Rename `routes` to `routeTable` on the last line, which has U+00A0 and no final line break  |
| `crlf`  | Remove the trailing comma of the last route, a CRLF line between two LF lines               |
| `bom`   | Turn the comment on the first line, right after the BOM, into a block comment               |

## Harnesses

| Harness | Tools declared to the model                                                  |
| ------- | ---------------------------------------------------------------------------- |
| `stock` | Pi's `read` and `edit`                                                       |
| `ide`   | The IDE's `read`, `replace`, `insert` and `delete`, loaded from the checkout |

Neither harness has `bash` or any other tool. A run whose declared tools, model or thinking level differ from the request counts as an `infra_error`. The IDE runs without post-processing, so a formatter cannot change the bytes after an edit.

## Results

Each run reports one result:

- `pass`: the file equals the expected file byte for byte.
- `unchanged`: the file equals the original.
- `wrong`: anything else, with whether the intended change was made, the special characters lost and added compared with the expected file (BOM, CR, LF, TAB, NBSP and the other format and space characters), and the first line that differs.
- `missing`: the file is gone.

The run itself has a separate status: `ok`, `model_error`, `infra_error`, `timed_out` or `cancelled`. A file is graded whatever the status, but only `ok` runs say something about the tools.

The results directory holds `manifest.json` (revision, source digest, Pi version and selection), `rows.json`, `report.md`, and for each run its prompt, Pi's JSON events, stderr, final `routes.ts` and `result.json`. Credentials are redacted from the events. The directory is under the ignored `.tmp/`; attach results to the task they belong to instead of committing them.

## Isolation

Each run gets a fresh directory with only `routes.ts`, an empty home and a private Pi agent directory, inside the matrix's Bubblewrap sandbox. The checkout is mounted read-only at `/source`, and its Git-ignored paths other than `node_modules`, such as `.tmp/` and `.env`, are hidden, so a run sees no other run's files or credentials. The checkout is not copied, so a run starts in seconds; the manifest records the revision and a digest of every tracked and unignored file, and the command reports and fails when the checkout changed during the run. Personal extensions, skills, context files and MCP servers are not loaded. Network access is shared.

## Self-check

`pnpm check:byte-exact-edit` is part of `pnpm check`. Without model calls it checks that the generated file has every listed special character, that each expected file differs from the original only in its span and keeps every special character, the grader on known good and damaged files, the Pi arguments of each harness, and a run of the runner with a scripted agent in place of Pi.
