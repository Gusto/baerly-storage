#!/usr/bin/env bash
# Send N requests per cell (default 200, after 5 warm-ups) to the deployed
# bench Worker; cells with their own sample count (the S1 probes) use it.
# Usage: ./run-cells.sh https://baerly-cpu-factor-bench.<subdomain>.workers.dev [N]
# Reads out/cells.txt (written by `pnpm bench:cpu-factor:build`). Runs two
# requests at a time so `wrangler tail` doesn't fall into sampling.
set -euo pipefail
URL="${1:?usage: ./run-cells.sh <workers.dev URL> [N]}"
N="${2:-200}"
cd "$(dirname "$0")"
while IFS=$'\t' read -r cell own; do
  [ -z "$cell" ] && continue
  n="${own:-$N}"
  echo "cell $cell ($n)"
  for _ in 1 2 3 4 5; do curl -s -o /dev/null "$URL/?cell=$cell&warmup=1"; done
  seq "$n" | xargs -P 2 -I{} curl -s -o /dev/null -w "%{http_code}\n" "$URL/?cell=$cell&i={}" \
    | sort | uniq -c | sed "s/^/  /"
done < out/cells.txt
