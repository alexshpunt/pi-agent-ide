#!/usr/bin/env bash
# Run integration tests in parallel shards. Each shard gets its own
# pi-test shared-runner host, so shards do not fight over one Pi pool.
#
# Usage: SHARDS=4 bash scripts/test-integration-shards.sh [vitest args...]
set -uo pipefail

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
shards="${SHARDS:-4}"
log_dir=".agents/tmp"
mkdir -p "$log_dir"

pids=()
for shard in $(seq 1 "$shards"); do
  pnpm exec pi-test run -- \
    vitest run --config vitest.integration.config.mjs "--shard=${shard}/${shards}" "$@" \
    > "${log_dir}/integration-shard-${shard}.log" 2>&1 &
  pids+=($!)
done

status=0
for index in "${!pids[@]}"; do
  shard=$((index + 1))
  if wait "${pids[$index]}"; then
    echo "shard ${shard}: passed"
  else
    echo "shard ${shard}: FAILED (${log_dir}/integration-shard-${shard}.log)"
    status=1
  fi
done

exit "$status"
