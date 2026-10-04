#!/usr/bin/env bash
# Run integration tests in parallel shards with standalone Pi processes.
# Shared pools retain every fixture configuration and exhaust CI memory.
#
# Usage: SHARDS=4 bash scripts/test-integration-shards.sh [vitest args...]
set -uo pipefail

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
shards="${SHARDS:-4}"
log_parent="${LOG_DIR:-.tmp}"
mkdir -p "$log_parent"
log_dir="$(mktemp -d "$log_parent/integration-shards.XXXXXX")"
echo "Integration logs: $log_dir"

report_dir="${REPORT_DIR:-}"
if [[ -n "$report_dir" ]]; then mkdir -p "$report_dir"; fi

pids=()
for shard in $(seq 1 "$shards"); do
  report_args=()
  if [[ -n "$report_dir" ]]; then
    report_args=(--reporter=default --reporter=junit "--outputFile.junit=${report_dir}/integration-${shard}.xml")
  fi
  env -u PI_INTEGRATION_TEST_RUNNER pnpm exec \
    vitest run --config vitest.integration.config.mjs "--shard=${shard}/${shards}" "${report_args[@]}" "$@" \
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
