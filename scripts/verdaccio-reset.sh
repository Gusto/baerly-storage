#!/usr/bin/env bash
set -euo pipefail

STORAGE="${HOME}/.local/share/verdaccio/storage"
URL="${VERDACCIO_URL:-http://localhost:4873}"

pkill -f Verdaccio 2>/dev/null || true
sleep 0.5

rm -rf "${STORAGE}/@gusto" "${STORAGE}/.verdaccio-db.json"

nohup verdaccio >/tmp/verdaccio.log 2>&1 &

for _ in $(seq 1 50); do
  if curl -sf "${URL}/-/ping" >/dev/null 2>&1; then
    echo "Verdaccio ready at ${URL} (logs: /tmp/verdaccio.log)"
    exit 0
  fi
  sleep 0.2
done

echo "Verdaccio did not respond within 10s; check /tmp/verdaccio.log" >&2
exit 1
