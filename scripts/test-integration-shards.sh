#!/usr/bin/env bash
# Run standalone shards as before, or opt in to memory-bounded file parallelism.
#
# Usage:
#   SHARDS=4 bash scripts/test-integration-shards.sh [vitest args...]
#   bash scripts/test-integration-shards.sh --parallel [file filters...]
#   bash scripts/test-integration-shards.sh --pooled <shared-safe file filter> [file filters...]
#
# PI_INTEGRATION_TEST_MAX_PI lowers the automatic cap in the opt-in modes.
# PI_TEST_CLI can point to a compatible pi-test executable for --pooled.
# On ZinPC, use an installed checkout at the pushed commit. Set CHECKOUT to that checkout,
# RUNNER to the versioned remote-machines tools directory, and JOB_ID to a unique job name:
#   PI_WORKER_LOCK=/home/user/.tmp/pi-worker/locks/pi-agent-ide-integration.lock \
#     bash "$RUNNER/start-job.sh" "$CHECKOUT" "$JOB_ID" env 'PI_SSH_COVERAGE_DIRECTIONS=linux>linux' \
#     bash scripts/test-integration-shards.sh --parallel tests/integration/empty-replace.integration.test.ts
# Check free memory before launch and the recorded job exit code when it finishes.
set -uo pipefail

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root" || exit 1
mode=shards
case "${1:-}" in
  --parallel|--pooled)
    mode="${1#--}"
    shift
    ;;
esac
if [[ "$mode" == pooled && $# == 0 ]]; then
  echo "Select only shared-safe integration files with --pooled." >&2
  exit 2
fi
if [[ "$mode" != shards ]]; then
  # Only selectors go to Vitest so callers cannot override the worker or isolation settings.
  for filter in "$@"; do
    if [[ -z "$filter" || "$filter" == -* ]]; then
      echo "--$mode takes Vitest file filters, not options." >&2
      exit 2
    fi
  done
fi

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

if [[ "$mode" != shards ]]; then
  workers=$(env -u PI_AGENT_IDE_INTEGRATION_MODE node --input-type=module -e '
    import { integrationWorkerLimit } from "./vitest.integration.config.mjs";
    console.log(integrationWorkerLimit({ pooled: process.argv[1] === "pooled" }));
  ' "$mode") || exit $?
  echo "Integration mode: $mode (up to $workers workers)"
  report_args=()
  if [[ -n "$report_dir" ]]; then
    report_args=(--reporter=default --reporter=junit "--outputFile.junit=${report_dir}/integration-${mode}.xml")
  fi
  command=(node node_modules/vitest/vitest.mjs run --config vitest.integration.config.mjs)
  if [[ "$mode" == pooled ]]; then
    pi_test="${PI_TEST_CLI:-$root/node_modules/.bin/pi-test}"
    if ! command -v -- "$pi_test" >/dev/null; then
      echo "Could not find pi-test; install dependencies or set PI_TEST_CLI." >&2
      exit 1
    fi
    command=("$pi_test" run -- "${command[@]}")
  fi
  log_file="${log_dir}/integration-${mode}.log"
  # Ignore the Vitest environment override so the whole-job cap cannot be bypassed.
  env -u PI_INTEGRATION_TEST_RUNNER -u VITEST_MAX_WORKERS \
    PATH="$root/node_modules/.bin:$PATH" PI_AGENT_IDE_INTEGRATION_MODE="$mode" \
    PI_INTEGRATION_TEST_MAX_PI="$workers" "${command[@]}" "${report_args[@]}" "$@" \
    > "$log_file" 2>&1
  status=$?
  if (( status == 0 )); then
    echo "$mode: passed"
  else
    echo "$mode: FAILED ($log_file)" >&2
    tail -n 20 -- "$log_file" >&2
  fi
  exit "$status"
fi

pids=()
for shard in $(seq 1 "$shards"); do
  report_args=()
  if [[ -n "$report_dir" ]]; then
    report_args=(--reporter=default --reporter=junit "--outputFile.junit=${report_dir}/integration-${shard}.xml")
  fi
  # Run Vitest directly: a pnpm exec wrapper stays alive for the whole shard and costs about
  # 150 MB of memory each.
  env -u PI_INTEGRATION_TEST_RUNNER -u PI_AGENT_IDE_INTEGRATION_MODE \
    PATH="$root/node_modules/.bin:$PATH" node node_modules/vitest/vitest.mjs \
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
