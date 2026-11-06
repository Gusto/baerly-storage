#!/usr/bin/env bash
# PostToolUse(Edit|Write): format the edited TS/JS file, then report lint
# errors for that file only, so they surface at edit time instead of at
# `pnpm verify:agent`. Silent on success; exit 2 sends findings to Claude.
set -u
f=$(jq -r '.tool_input.file_path // empty')
case "$f" in *.ts|*.tsx|*.mts|*.mjs) ;; *) exit 0 ;; esac
[ -f "$f" ] || exit 0
root=$(git -C "$(dirname "$f")" rev-parse --show-toplevel 2>/dev/null) || exit 0
bin="$root/node_modules/.bin"
[ -x "$bin/oxlint" ] || bin="${CLAUDE_PROJECT_DIR:-$root}/node_modules/.bin"
[ -x "$bin/oxlint" ] || exit 0
cd "$root" || exit 0
"$bin/oxfmt" "$f" >/dev/null 2>&1
out=$("$bin/oxlint" --format=unix --quiet "$f" 2>&1) && exit 0
printf 'oxlint findings in %s (fix before verify):\n%s\n' "$f" "$out" >&2
exit 2
