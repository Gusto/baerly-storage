#!/usr/bin/env bash
# Fails if any token from .deprecated-tokens.txt appears in tracked
# files. Used to catch reintroduction of renamed paths.
#
# Workflow: when a rename PR lands, it adds the OLD token to
# .deprecated-tokens.txt in the same commit. This script (wired into
# lefthook pre-commit and runnable as `pnpm check:references`) then
# fails any subsequent commit that reintroduces the token.

set -euo pipefail

BANLIST=".deprecated-tokens.txt"

if [[ ! -f "$BANLIST" ]]; then
  exit 0
fi

# Read tokens — strip `#` comments, blank lines, surrounding whitespace.
tokens=()
while IFS= read -r line || [[ -n "$line" ]]; do
  cleaned="${line%%#*}"
  cleaned="${cleaned#"${cleaned%%[![:space:]]*}"}"
  cleaned="${cleaned%"${cleaned##*[![:space:]]}"}"
  [[ -n "$cleaned" ]] && tokens+=("$cleaned")
done < "$BANLIST"

if [[ ${#tokens[@]} -eq 0 ]]; then
  exit 0
fi

# Escape regex metachars so tokens are matched as fixed substrings.
escaped=()
for t in "${tokens[@]}"; do
  escaped+=("$(printf '%s' "$t" | sed -E 's|[][\\.^$*+?(){}|]|\\&|g')")
done
pattern="$(IFS='|'; echo "${escaped[*]}")"

# `git grep` handles weird filenames natively, respects .gitignore,
# and supports pathspec exclusions. Skip the banlist itself, the
# scratch/research dirs, and commit-pinned github permalinks.
matches=$(
  git grep -nE "$pattern" \
    -- \
    ":(exclude)$BANLIST" \
    ':(exclude)docs/research/' \
  | grep -vE 'github\.com/[^[:space:]]*/blob/' \
  || true
)

if [[ -n "$matches" ]]; then
  echo "check:references: deprecated tokens reintroduced (see $BANLIST):"
  echo "$matches"
  exit 1
fi
