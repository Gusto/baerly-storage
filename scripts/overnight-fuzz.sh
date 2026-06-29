#!/usr/bin/env bash
# overnight-fuzz.sh — Overnight correctness fuzz-hunt driver for the 0.x soak.
#
# PURPOSE
#   Loops the repo's property-based and crash-injection fuzz suites with
#   fresh fast-check randomness each iteration. Tees all output to a
#   timestamped log under reports/overnight/. Halts (or logs and continues)
#   on the first real failure so the operator wakes up to a clear finding.
#
# WHY pnpm exec vitest (not pnpm test:fuzz-maintenance / pnpm test:randomize)
#   `pnpm build` MUST be run once before starting this script. Calling
#   `pnpm exec vitest run ...` directly skips the `pretest` build hook
#   intentionally — this avoids three concurrent rolldown rebuilds racing
#   on dist/ across the parallel loop iterations. This is the documented
#   exception to the repo's "don't call vitest directly" anti-pattern.
#   (CLAUDE.md: "building once up front then calling vitest directly avoids
#   three concurrent rolldown rebuilds racing on dist/ per iteration.")
#
# ENV KNOBS (all optional, shown with defaults)
#   FC_NUM_RUNS=10000      fast-check iterations per property per suite.
#                          maintenance-crash-fuzz is always capped at 5000 (its
#                          600s/property timeout is hard-coded and not scaled
#                          by FC_NUM_RUNS — 10000 timed out 7/102 overnight).
#                          The other suites use the full value.
#   MAX_HOURS=9            Wall-clock cap (SECONDS builtin). 0 = unlimited.
#                          Checked between suites, not mid-suite — actual runtime
#                          can exceed MAX_HOURS by up to the longest single-suite
#                          duration (several min for maintenance-crash-fuzz at its 5000 cap).
#   BREAK_ON_FAIL=1        1 = stop on first failure; 0 = log and continue.
#   SKIP_MINIO=0           1 = skip the node-minio Toxiproxy variant even if
#                          Minio is healthy.
#   SKIP_CF=0              1 = skip the cloudflare-r2 Workerd variant.
#   DRY_RUN=0              1 = run pre-flight, print planned commands, exit 0
#                          without executing the long suites.
#
# DELIBERATELY EXCLUDED (require vendor credentials — separate run)
#   test:conformance, test:manual-e2e, bench:r2

set -uo pipefail
# NOTE: set -e is intentionally NOT set globally. Suite failures must be
# caught via ${PIPESTATUS[0]} rather than letting the shell abort; a global
# -e would terminate the script on any non-zero exit before we can record
# the failure and apply the BREAK_ON_FAIL policy.

# ---------------------------------------------------------------------------
# Resolve repo root (the script lives in scripts/)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Knobs with defaults
# ---------------------------------------------------------------------------
FC_NUM_RUNS="${FC_NUM_RUNS:-10000}"
MAX_HOURS="${MAX_HOURS:-9}"
BREAK_ON_FAIL="${BREAK_ON_FAIL:-1}"
SKIP_MINIO="${SKIP_MINIO:-0}"
SKIP_CF="${SKIP_CF:-0}"
DRY_RUN="${DRY_RUN:-0}"

MINIO_HEALTH="http://127.0.0.1:9102/minio/health/live"
# Ceiling for maintenance-crash-fuzz only. PROP_TIMEOUT_MS=600s/property is hard-coded
# in the test and NOT scaled by FC_NUM_RUNS. An overnight run at FC_NUM_RUNS=10000
# timed out 7/102 times across 5 different heavy properties on this hardware; at
# FC_NUM_RUNS=500 the suite finishes in ~12s, so 5000 stays comfortably under the
# 600s cap with margin. The other suites are unaffected (and FC_NUM_RUNS is a
# near-no-op for the fault-injection-driven randomized cascade anyway).
CRASH_FUZZ_MAX_FC=5000

# ---------------------------------------------------------------------------
# Derived: clamped FC_NUM_RUNS for maintenance-crash-fuzz
# ---------------------------------------------------------------------------
if [ "$FC_NUM_RUNS" -gt "$CRASH_FUZZ_MAX_FC" ]; then
  CRASH_FUZZ_FC=$CRASH_FUZZ_MAX_FC
  CRASH_FUZZ_CLAMPED=1
else
  CRASH_FUZZ_FC=$FC_NUM_RUNS
  CRASH_FUZZ_CLAMPED=0
fi

# ---------------------------------------------------------------------------
# Log file setup
# ---------------------------------------------------------------------------
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"
LOG_DIR="$REPO_ROOT/reports/overnight"
LOG_FILE="$LOG_DIR/fuzz-${TIMESTAMP}.log"
mkdir -p "$LOG_DIR"

# Open log fd 3 for tee so we can redirect from here on.
# tee ignores INT/TERM so it survives Ctrl-C and flushes the final banner on pipe-EOF.
exec > >(trap '' INT TERM; tee -a "$LOG_FILE") 2>&1

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[fuzz] $*"; }
warn() { echo "[fuzz] WARN: $*"; }
err()  { echo "[fuzz] ERROR: $*" >&2; }

elapsed_hm() {
  local secs=$SECONDS
  printf "%dh %02dm" $((secs / 3600)) $(((secs % 3600) / 60))
}

# ---------------------------------------------------------------------------
# Print header
# ---------------------------------------------------------------------------
log "===== overnight-fuzz started  $(date)  log=$LOG_FILE ====="
log "FC_NUM_RUNS=$FC_NUM_RUNS  MAX_HOURS=$MAX_HOURS  BREAK_ON_FAIL=$BREAK_ON_FAIL  SKIP_MINIO=$SKIP_MINIO  SKIP_CF=$SKIP_CF  DRY_RUN=$DRY_RUN"

if [ "$CRASH_FUZZ_CLAMPED" -eq 1 ]; then
  log "maintenance-crash-fuzz capped at FC_NUM_RUNS=$CRASH_FUZZ_MAX_FC (its 600s/property timeout is hard-coded and not scaled by FC_NUM_RUNS; higher risks spurious timeouts and orphan-iteration bleed). The other suites use FC_NUM_RUNS=$FC_NUM_RUNS."
fi

# ---------------------------------------------------------------------------
# STOPPED marker + grep hint (called on exit / signal)
# ---------------------------------------------------------------------------
STOP_REASON="unknown"
ITERATION_COUNT=0

print_stopped() {
  echo ""
  log "===== STOPPED after ${ITERATION_COUNT} iteration(s) — reason=${STOP_REASON} — $(date) ====="
  log "Log: $LOG_FILE"
  log "Morning summary hint:"
  log "  grep -nE 'FOUND FAILURE|Property failed|✗|FAIL' '$LOG_FILE'"
}

trap 'STOP_REASON=signal; print_stopped; exit 130' INT TERM

# ---------------------------------------------------------------------------
# Pre-flight: dist/ check
# ---------------------------------------------------------------------------
log "--- pre-flight: dist/ ---"
if [ ! -d "$REPO_ROOT/dist" ]; then
  err "dist/ not found. Run \`pnpm build\` first — this script calls \`pnpm exec vitest\` which skips the build hook."
  STOP_REASON=preflight-fail
  print_stopped
  exit 1
fi
log "dist/ present — OK"

# ---------------------------------------------------------------------------
# Pre-flight: Minio health probe
# ---------------------------------------------------------------------------
log "--- pre-flight: Minio ---"
INCLUDE_MINIO=0
if [ "$SKIP_MINIO" -eq 1 ]; then
  log "SKIP_MINIO=1 — skipping node-minio variant"
else
  if curl -sf --max-time 3 "$MINIO_HEALTH" >/dev/null 2>&1; then
    log "Minio healthy at $MINIO_HEALTH — node-minio variant INCLUDED"
    INCLUDE_MINIO=1
  else
    warn "Minio unreachable at $MINIO_HEALTH — node-minio variant SKIPPED. Run \`pnpm dev:storage\` to enable it."
    INCLUDE_MINIO=0
  fi
fi

# ---------------------------------------------------------------------------
# Pre-flight: Cloudflare / workerd probe (downloads binary on first run)
# ---------------------------------------------------------------------------
log "--- pre-flight: Cloudflare workerd ---"
INCLUDE_CF=0
if [ "$SKIP_CF" -eq 1 ]; then
  log "SKIP_CF=1 — skipping cloudflare-r2 variant"
elif [ "$DRY_RUN" -eq 1 ]; then
  log "DRY_RUN=1 — skipping CF pre-flight execution (would run: pnpm exec vitest run --project=cloudflare-pool packages/adapter-cloudflare/src/randomized.test.ts --reporter=dot)"
  # In dry-run we optimistically include CF so the dry-run plan is complete;
  # the real run will do the actual probe.
  INCLUDE_CF=1
else
  log "Running CF pre-flight (may download workerd binary on first run)..."
  CF_PREFLIGHT_LOG="$LOG_DIR/cf-preflight-${TIMESTAMP}.log"
  # errexit is intentionally off — a failing pre-flight must not abort the script.
  # FC_NUM_RUNS is intentionally passed at full value here: the cloudflare randomized
  # cascade ignores FC_NUM_RUNS (fixed fault-injection sequence), so the full value
  # costs no extra time. A low value like FC_NUM_RUNS=1 would drop testTimeout /
  # hookTimeout to 5 s and cause the first-run workerd binary download to time out.
  FC_NUM_RUNS="$FC_NUM_RUNS" pnpm exec vitest run \
    --project=cloudflare-pool \
    packages/adapter-cloudflare/src/randomized.test.ts \
    --reporter=dot \
    > "$CF_PREFLIGHT_LOG" 2>&1
  CF_EXIT="${PIPESTATUS[0]}"
  cat "$CF_PREFLIGHT_LOG"
  rm -f "$CF_PREFLIGHT_LOG"
  if [ "$CF_EXIT" -eq 0 ]; then
    log "CF pre-flight passed — cloudflare-r2 variant INCLUDED"
    INCLUDE_CF=1
  else
    warn "CF pre-flight failed (exit $CF_EXIT) — cloudflare-r2 variant EXCLUDED for this run. Check workerd / miniflare setup."
    INCLUDE_CF=0
  fi
fi

# ---------------------------------------------------------------------------
# DRY_RUN: print plan and exit
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  log ""
  log "===== DRY RUN — planned per-iteration suite commands ====="
  log ""
  log "CORE A (zero infra) — maintenance-crash-fuzz:"
  log "  FC_NUM_RUNS=$CRASH_FUZZ_FC pnpm exec vitest run --project=default tests/integration/maintenance-crash-fuzz.test.ts --reporter=dot"
  log ""
  if [ "$INCLUDE_MINIO" -eq 1 ]; then
    log "randomized (MINIO=1: mem+local-fs+node-minio): INCLUDED"
    log "  MINIO=1 FC_NUM_RUNS=$FC_NUM_RUNS pnpm exec vitest run --project=default tests/integration/randomized.test.ts --reporter=dot"
  else
    log "randomized (mem+local-fs): INCLUDED (node-minio SKIPPED — Minio not available or SKIP_MINIO=1)"
    log "  FC_NUM_RUNS=$FC_NUM_RUNS pnpm exec vitest run --project=default tests/integration/randomized.test.ts --reporter=dot"
  fi
  log ""
  if [ "$INCLUDE_CF" -eq 1 ]; then
    log "OPT CF — randomized (cloudflare-r2 Workerd variant): INCLUDED"
    log "  FC_NUM_RUNS=$FC_NUM_RUNS pnpm exec vitest run --project=cloudflare-pool packages/adapter-cloudflare/src/randomized.test.ts --reporter=dot"
  else
    log "OPT CF — randomized (cloudflare-r2 Workerd variant): SKIPPED"
  fi
  log ""
  log "Wall-clock cap: MAX_HOURS=$MAX_HOURS (0 = unlimited)"
  log "Failure policy: BREAK_ON_FAIL=$BREAK_ON_FAIL"
  log ""
  log "===== DRY RUN complete — no suites executed ====="
  STOP_REASON=dry-run
  # Bypass the trap's print (already printing cleanly here)
  trap - INT TERM
  exit 0
fi

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
MAX_SECS=$(( MAX_HOURS * 3600 ))
FOUND_FAILURE=0
ITERATION_COUNT=0

while true; do
  # Wall-clock cap check
  if [ "$MAX_HOURS" -gt 0 ] && [ "$SECONDS" -ge "$MAX_SECS" ]; then
    STOP_REASON=cap
    break
  fi

  ITERATION_COUNT=$(( ITERATION_COUNT + 1 ))
  log "===== iteration $ITERATION_COUNT  $(date)  (elapsed $(elapsed_hm)) ====="

  # --- CORE A: maintenance-crash-fuzz ---
  # errexit is intentionally off globally — SUITE_EXIT captures the exit code so
  # a failing suite doesn't abort the script; BREAK_ON_FAIL controls continuation.
  FC_NUM_RUNS="$CRASH_FUZZ_FC" pnpm exec vitest run \
    --project=default \
    tests/integration/maintenance-crash-fuzz.test.ts \
    --reporter=dot
  SUITE_EXIT="${PIPESTATUS[0]}"
  if [ "$SUITE_EXIT" -ne 0 ]; then
    log "FOUND FAILURE in CORE-A (maintenance-crash-fuzz) at iteration $ITERATION_COUNT (exit $SUITE_EXIT)"
    FOUND_FAILURE=1
    if [ "$BREAK_ON_FAIL" -eq 1 ]; then STOP_REASON=failure; break; fi
  fi

  # Wall-clock cap between suites
  if [ "$MAX_HOURS" -gt 0 ] && [ "$SECONDS" -ge "$MAX_SECS" ]; then
    STOP_REASON=cap
    break
  fi

  # --- randomized (node-side variants) ---
  # INCLUDE_MINIO=1: passes MINIO=1 which activates the node-minio Toxiproxy
  # variant in addition to memory+local-fs (those are unconditional).
  # INCLUDE_MINIO=0: runs memory+local-fs only.
  # Collapsed from the former CORE-B + OPT-MINIO pair to avoid running
  # memory+local-fs twice per iteration (they are unconditional in both runs).
  if [ "$INCLUDE_MINIO" -eq 1 ]; then
    _RANDOMIZED_LABEL="randomized (MINIO=1: mem+local-fs+node-minio)"
    _RANDOMIZED_ENV="MINIO=1"
  else
    _RANDOMIZED_LABEL="randomized (mem+local-fs)"
    _RANDOMIZED_ENV=""
  fi
  env $_RANDOMIZED_ENV FC_NUM_RUNS="$FC_NUM_RUNS" pnpm exec vitest run \
    --project=default \
    tests/integration/randomized.test.ts \
    --reporter=dot
  SUITE_EXIT="${PIPESTATUS[0]}"
  if [ "$SUITE_EXIT" -ne 0 ]; then
    log "FOUND FAILURE in $_RANDOMIZED_LABEL at iteration $ITERATION_COUNT (exit $SUITE_EXIT)"
    FOUND_FAILURE=1
    if [ "$BREAK_ON_FAIL" -eq 1 ]; then STOP_REASON=failure; break; fi
  fi

  # Wall-clock cap between suites
  if [ "$MAX_HOURS" -gt 0 ] && [ "$SECONDS" -ge "$MAX_SECS" ]; then
    STOP_REASON=cap
    break
  fi

  # --- OPT CF: randomized (cloudflare-r2 Workerd variant) ---
  if [ "$INCLUDE_CF" -eq 1 ]; then
    FC_NUM_RUNS="$FC_NUM_RUNS" pnpm exec vitest run \
      --project=cloudflare-pool \
      packages/adapter-cloudflare/src/randomized.test.ts \
      --reporter=dot
    SUITE_EXIT="${PIPESTATUS[0]}"
    if [ "$SUITE_EXIT" -ne 0 ]; then
      log "FOUND FAILURE in OPT-CF (randomized cloudflare-r2) at iteration $ITERATION_COUNT (exit $SUITE_EXIT)"
      FOUND_FAILURE=1
      if [ "$BREAK_ON_FAIL" -eq 1 ]; then STOP_REASON=failure; break; fi
    fi

    # Wall-clock cap between suites
    if [ "$MAX_HOURS" -gt 0 ] && [ "$SECONDS" -ge "$MAX_SECS" ]; then
      STOP_REASON=cap
      break
    fi
  fi
done

# If we exited the loop without setting a stop reason (shouldn't happen, but
# guard against it)
if [ "$STOP_REASON" = "unknown" ]; then
  STOP_REASON=cap
fi

print_stopped

if [ "$FOUND_FAILURE" -eq 1 ]; then
  exit 1
fi
exit 0
