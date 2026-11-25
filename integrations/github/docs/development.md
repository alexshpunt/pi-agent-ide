# Development

## Checkout setup

Use Node.js 24 or newer. From the repository root, install the workspace dependencies:

```bash
pnpm install --frozen-lockfile
```

The GitHub package uses the workspace's IDE SDK directly. No second checkout or dependency link is needed. To load GitHub from source in a test Pi session, run `pi --no-extensions -e ./integrations/github -e builtin:tool-search` from the repository root. Enable the IDE extension separately to use its shared resource tools.

## Packed candidate setup

From the repository root, pack just the GitHub package:

```bash
pnpm --filter pi-agent-github pack
```

Install the resulting tarball in a separate npm project with a compatible Pi host. The tarball depends on the published IDE SDK; it does not install the IDE into Pi's settings.

```bash
npm install @earendil-works/pi-coding-agent@1.5.2 /path/to/pi-agent-github-0.1.0.tgz
```

Use an isolated Pi profile and load only GitHub to test standalone mode:

```bash
PI_CODING_AGENT_DIR="$PWD/.pi-candidate" npx pi --no-extensions \
  -e ./node_modules/pi-agent-github -e builtin:tool-search
```

Add `-e ./node_modules/pi-agent-ide` to enable IDE mode. Discover `github_read` in standalone or use `read` in IDE mode to open `docs:github`.

## Checks

From the repository root, select the checks needed for the change:

```bash
pnpm --filter pi-agent-github typecheck
pnpm exec vitest run integrations/github/tests/config.test.ts
pnpm exec pi-test run -- vitest run --config vitest.integration.config.mjs integrations/github/tests/automatic-modes.integration.test.ts
```

The integration tests use deterministic API fixtures, not live mutations or real model calls. They discover the SDK from the installed dependency in the test environment. For live checks, use the intended identity and read a known resource; do not mutate a repository to prove that the adapter loaded.

## Request coordination

Production admission is keyed by quota owner and host. REST, GraphQL, authentication, token refresh, OAuth and asset requests use the same coordinator. API and upload hosts share a quota key; CDN and OAuth origins stay separate. Primary exhaustion blocks its bucket; confirmed secondary limits block the owner's API sends across buckets. A valid response with no quota remaining is returned normally and blocks later sends.

Sends are serialized per owner/host. Mutation admissions use a 1000 ms pacing interval. The local queue defaults to 64 entries and a 15-second admission wait. Cancellation before dispatch is not applied; dispatch, verification or state-observation failures must preserve the actual operation effect. There is no automatic mutation replay or account fallback.

The default state directory is `~/.config/pi-agent-github/rate-limits`, or `rate-limits` beneath `PI_GITHUB_CONFIG_DIR`. POSIX directories/files use 0700/0600 permissions, hashed owner/host names, validated atomic updates and cross-process leases. Unsafe state fails closed rather than disabling coordination. These permissions do not protect against other processes running as the same OS user.

Only identical in-flight GETs within one client/credential generation are shared. Readers receive independent response bytes and cancellation; a mutation retires that read epoch. There is no persistent mutable-resource cache. The resource adapter reuses the verified snapshot returned by save, but save still requires fresh pre-save and post-save checks.

HTTP fixtures must inject an isolated `GithubRequestCoordinator` explicitly, using `directory: null` and zero mutation spacing when appropriate. A mock fetcher does not disable production admission. Exercise owner isolation, zero sends during cooldown, cross-process state, cancelled queues, fresh-save checks and unknown effects at the HTTP boundary. The real-Pi cases must also check public structured metadata, model text and native TUI output in both modes. Keep measurements and run artifacts with the task, not in these docs.

## Public package checks

Inspect the candidate archive and test installation from that archive in an isolated Pi configuration. Check that runtime dependencies, entry points, guides, license and preview assets are included, with no checkout paths, credentials or developer-only artifacts.

Preparing the package does not publish it. Changing repository visibility, creating release tags, publishing to npm and publishing a GitHub release are separate operations.

## Branding

`assets/banner.png` is the 1280×720 README and Pi gallery image.
