#!/usr/bin/env bash
# Exercise native CLI selection before the integration harness starts its session.
set -euo pipefail
args=()
case "${PI_AGENT_IDE_TEST_SELECTION:-}" in
  exclude) args=(--exclude-tools debug,stage,unstage) ;;
  allow) args=(--tools read,diff,codemode,tool_search,ide_exposure_probe) ;;
  no-tools) args=(--no-tools) ;;
  no-builtins) args=(--no-builtin-tools) ;;
  *) echo "Unknown IDE test tool selection" >&2; exit 2 ;;
esac
exec "${PI_AGENT_IDE_TEST_HOST_COMMAND:-pi}" "${args[@]}" "$@"
