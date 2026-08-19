#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

exec "$repo_root/node_modules/.bin/pi-test" live \
  --cwd "$repo_root" \
  --delay-ms 17 \
  --pause-ms 2000 \
  -- \
  "$repo_root/node_modules/.bin/vitest" run "$repo_root/tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/mutation-renderer.integration.test.ts" \
  --config "$repo_root/vitest.integration.config.mjs" \
  -t "shows the real replacement as a stable compact diff panel"
