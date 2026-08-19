#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

exec "$repo_root/node_modules/.bin/pi-test" live \
  --cwd "$repo_root" \
  --stream-profile gpt-5.6-sol-xhigh \
  --pause-ms 3000 \
  -- \
  "$repo_root/node_modules/.bin/vitest" run "$repo_root/tests/integration/interactive-demos/read-code-views.integration.test.ts" \
  --config "$repo_root/vitest.integration.config.mjs" \
  -t "shows every read code-view protocol on a production TypeScript file"
