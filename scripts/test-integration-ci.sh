#!/usr/bin/env bash
# Run one CI shard or the separate privileged namespace group, retaining logs on failure.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
mode="${1:?Supply a shard such as 1/4, or namespaces}"
namespace_files=(
  tests/integration/ssh-process-namespaces.integration.test.ts
  tests/integration/ssh-process-namespaces-tools.integration.test.ts
  tests/integration/ssh-file-identities.integration.test.ts
  tests/integration/ssh-web-network-tools.integration.test.ts
)
arguments=()
if [[ "$mode" == namespaces ]]; then
  arguments=("${namespace_files[@]}")
  report=namespaces
elif [[ "$mode" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] && (( BASH_REMATCH[1] <= BASH_REMATCH[2] )); then
  arguments=("--shard=$mode")
  report="${BASH_REMATCH[1]}"
  for file in "${namespace_files[@]}"; do arguments+=(--exclude "$file"); done
else
  echo "Invalid integration group: $mode" >&2
  exit 2
fi
mkdir -p .tmp/integration-ci .agents/tmp/test-results
env -u PI_INTEGRATION_TEST_RUNNER pnpm exec vitest run --config vitest.integration.config.mjs \
  "${arguments[@]}" --reporter=default --reporter=junit \
  "--outputFile.junit=.agents/tmp/test-results/integration-$report.xml" \
  2>&1 | tee ".tmp/integration-ci/$report.log"
