#!/usr/bin/env bash
# Fetch and extract corpora for the load-harness calibration.
#
# Idempotent: re-running with files already downloaded is a no-op
# (the corpus file is checked for existence; the extractor always
# overwrites calibration.json so the file always reflects the
# corpora currently on disk).
#
# Outputs:
#   bench/fixtures/ml-100k/u.data                     (MovieLens 100K ratings TSV)
#   bench/fixtures/gharchive/2024-01-07-4.json        (1h slice, filtered WatchEvents)
#   bench/load-harness/presets/calibration.json       (checked in)
#
# Corpora & licenses:
#   MovieLens 100K — frozen April 1998 dataset; research /
#     educational use only. Cite: GroupLens.
#   GH Archive WatchEvent — public events stream; CC BY 4.0.
#     Per-event payloads are public GitHub data.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES_DIR="$REPO_ROOT/bench/fixtures"
ML_DIR="$FIXTURES_DIR/ml-100k"
GH_DIR="$FIXTURES_DIR/gharchive"
CAL_OUT="$REPO_ROOT/bench/load-harness/presets/calibration.json"

ML_URL="https://files.grouplens.org/datasets/movielens/ml-100k.zip"
ML_ZIP="$FIXTURES_DIR/ml-100k.zip"

# Sunday 04:00 UTC, head-50k records. Date intentionally fixed
# (frozen-corpus shape): a stable date with predictable WatchEvent
# volume. Update the date here AND in calibration's `_source` field
# if you re-pull.
GH_DATE="2024-01-07"
GH_HOUR="4"
GH_URL="https://data.gharchive.org/${GH_DATE}-${GH_HOUR}.json.gz"
GH_GZ="$GH_DIR/${GH_DATE}-${GH_HOUR}.json.gz"
GH_NDJSON="$GH_DIR/${GH_DATE}-${GH_HOUR}.json"

# --- Preflight checks ---
command -v curl >/dev/null 2>&1 || {
  echo "[fixtures] ERROR: 'curl' not found. Install via 'brew install curl' or 'apt install curl'." >&2
  exit 2
}
command -v jq >/dev/null 2>&1 || {
  echo "[fixtures] ERROR: 'jq' not found. Install via 'brew install jq' or 'apt install jq'." >&2
  exit 2
}

mkdir -p "$ML_DIR" "$GH_DIR" "$(dirname "$CAL_OUT")"

# --- MovieLens 100K ---
if [ -f "$ML_DIR/u.data" ]; then
  echo "[fixtures] MovieLens 100K already present at $ML_DIR/u.data — skip"
else
  command -v unzip >/dev/null 2>&1 || {
    echo "[fixtures] ERROR: 'unzip' not found. Install via 'brew install unzip' or 'apt install unzip'." >&2
    exit 2
  }
  echo "[fixtures] Downloading MovieLens 100K → $ML_ZIP"
  curl -L --fail --output "$ML_ZIP" "$ML_URL"
  echo "[fixtures] Unzipping → $FIXTURES_DIR"
  unzip -o -d "$FIXTURES_DIR" "$ML_ZIP"
  rm "$ML_ZIP"
fi

# --- GH Archive WatchEvent slice ---
if [ -f "$GH_NDJSON" ]; then
  echo "[fixtures] GH Archive ${GH_DATE}-${GH_HOUR} already present at $GH_NDJSON — skip"
else
  echo "[fixtures] Downloading GH Archive ${GH_DATE}-${GH_HOUR} → $GH_GZ"
  curl -L --fail --output "$GH_GZ" "$GH_URL"
  echo "[fixtures] Filtering to WatchEvent (head 50000) → $GH_NDJSON"
  # Use gunzip + jq to filter WatchEvents only. gunzip -c pipes to stdout.
  # jq -c 'select(.type == "WatchEvent")' keeps only WatchEvent lines.
  # head -n 50000 limits to 50k records.
  TMP="${GH_NDJSON}.tmp"
  gunzip -c "$GH_GZ" | jq -c 'select(.type == "WatchEvent")' | head -n 50000 > "$TMP"
  mv "$TMP" "$GH_NDJSON"
  rm "$GH_GZ"
fi

# --- Extract calibration ---
echo "[fixtures] Extracting calibration → $CAL_OUT"
node --import "$REPO_ROOT/bench/register-hooks.mjs" \
  "$REPO_ROOT/scripts/extract-bench-calibration.ts"

echo "Done. calibration.json updated. Corpora cached under bench/fixtures/."
