#!/usr/bin/env bash
# Codex's own sandbox, as its access tiers below full use it: in workspace-write the workspace is writable and nothing
# else is, in read-only nothing is, and neither reaches the network. Runs the `codex` first on PATH from a scratch
# workspace; exits 1 naming what broke. CI runs it on Linux with `.github/actions/codex-sandbox`, as the daily bump does.
set -uo pipefail
workspace=$(mktemp -d)
outside=$(mktemp -d)
trap 'rm -rf "$workspace" "$outside"' EXIT
cd "$workspace" || exit 1
echo "$(codex --version)"
tries="touch inside 2>/dev/null && echo wrote-workspace; touch '$outside/escaped' 2>/dev/null && echo wrote-outside; getent hosts github.com >/dev/null 2>&1 && echo online; echo ran"
said() { tr '\n' ' ' <<<"$1" | grep -oE "wrote-workspace|wrote-outside|online|ran" | tr '\n' ' ' | sed 's/ $//'; }
failed=0
check() {
  local mode=$1 expected=$2 output
  output=$(codex sandbox -c "sandbox_mode=$mode" -- sh -c "$tries" 2>&1)
  if [ "$(said "$output")" != "$expected" ]; then
    echo "codex sandbox $mode: expected \"$expected\", got:"
    echo "$output" | sed 's/^/  /'
    failed=1
  else
    echo "codex sandbox $mode: $expected"
  fi
}
check workspace-write "wrote-workspace ran"
rm -f inside
check read-only "ran"
exit $failed
