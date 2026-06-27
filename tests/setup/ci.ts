/**
 * CI-environment test helpers.
 *
 * GitHub-hosted `ubuntu-latest` runners are 2-vCPU with a markedly slower
 * single core than a typical dev machine, and under `pool: "forks"` the
 * heavy CPU/LocalFs-bound integration tests also contend for those two
 * cores. Both effects are wall-clock, not correctness: the same assertions
 * run and pass, they just need headroom. Per-test timeouts authored against
 * dev-core speed are too tight there — which is why CI has flaked on a
 * rotating cast of heavy tests (maintenance-e2e / maintenance-profile) as each one
 * crossed its individual ceiling under contention.
 *
 * `ciTimeout` widens a per-test timeout on CI only, so the tighter local
 * bound stays the day-to-day signal (a contributor still sees a test that
 * has grown slow). Apply it uniformly to the heavy maintenance/compaction
 * suites rather than bumping individual timeouts reactively.
 *
 * `CI=true` is set by GitHub Actions and most other CI providers.
 */

/** True when running under CI (GitHub Actions sets `CI=true`). */
export const IS_CI = !!process.env["CI"];

/**
 * Widen a per-test timeout when running on CI; return it unchanged locally.
 *
 * The factor (default 3×) is empirical headroom for the slower, contended
 * CI core. A timeout is a ceiling, so green runs never pay it — only a
 * genuinely hung test burns the full budget, and the job-level
 * `timeout-minutes` still backstops that.
 *
 * Note this is a different multiplier from the global default-timeout
 * widening in `vitest.config.ts` (4×: 5s → 20s). That widens the 5s base
 * every default test inherits; `ciTimeout` is applied per-test on the
 * heavy maintenance/compaction suites, which already carry much larger
 * bases (30s–120s). Two independent tunings against two different bases,
 * not one shared constant — keep them separate.
 */
export function ciTimeout(baseMs: number, factor = 3): number {
  return IS_CI ? baseMs * factor : baseMs;
}
