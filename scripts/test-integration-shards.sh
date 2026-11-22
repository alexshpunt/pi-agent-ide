#!/usr/bin/env bash
# Run integration tests in parallel shards with standalone Pi processes.
# Shared pools retain every fixture configuration and exhaust CI memory.
#
# Usage: SHARDS=4 bash scripts/test-integration-shards.sh [vitest args...]
set -uo pipefail

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
# Size SHARDS by the whole process tree of one shard, not by one Pi: the vitest worker, Pi and the
# language servers its tests start (tsserver, clangd) take about 1 GB per shard and grow.
shards="${SHARDS:-4}"
# Each test workspace gets its own language-server host; stop it soon after its Pi exits, or
# finished workspaces keep their servers for the default 10 minutes and fill memory.
export PI_AGENT_IDE_LSP_LINGER_MS="${PI_AGENT_IDE_LSP_LINGER_MS:-5000}"
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
  # Run Vitest directly: a pnpm exec wrapper stays alive for the whole shard and costs about
  # 150 MB of memory each.
  env -u PI_INTEGRATION_TEST_RUNNER PATH="$root/node_modules/.bin:$PATH" node node_modules/vitest/vitest.mjs \
    run --config vitest.integration.config.mjs "--shard=${shard}/${shards}" "${report_args[@]}" "$@" \
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
