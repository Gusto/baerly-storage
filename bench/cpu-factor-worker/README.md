# Deployed workerd CPU bench

An owner-deployed Cloudflare Worker that measures, on a real Workers account, per-invocation CPU (`cpuTime`) and outcomes for three groups of cells. Nothing here runs in `pnpm verify` or `pnpm test` beyond the analyzer unit test.

- **Fold cells:** the current tree's fold invocation (a write that reaches the fold, then one `compact()` pass at the Cloudflare Free options) over synthetic fixtures. They give the deployed/Node factor.
- **Tree fold-step cells (`tree-k<k>-b<B>-d<d>[-distinct]`):** a synthetic step on a content-addressed tree: re-encode `k` leaves (JSON) of about `B` KiB, SHA-256 each with `crypto.subtle.digest`, then re-encode and hash the path nodes. Grid: k in {1,2,4,8}, B in {4,16,64} KiB, d in {1,2,3}, in two path modes (an explicit cell dimension; the analyzer reports and groups by it):
  - **`shared`** (names without suffix, e.g. `tree-k4-b16-d2`): all k leaves under one root-to-leaf path, so the step touches `d` nodes (best case). 36 cells.
  - **`distinct`** (`-distinct` suffix, e.g. `tree-k4-b16-d2-distinct`): k leaves on k distinct root-to-leaf paths that merge only where forced. Level `L` from the root (0 = root) holds `min(k, 64^L)` nodes (fanout 64), so the step touches `sum over L<d of min(k, 64^L)` nodes, which is `1 + k*(d-1)` for k <= 64 (one root, k per lower level). d = 1 is a single node in both modes, so there are no distinct d = 1 cells: 24 cells.

  The report says how many leaves fit under Free's ~10 ms per (path, B, d), measured directly with no factor involved.

- **S1 probe cells (`probe-r2-head`, `probe-fetch`, `probe-cache-match`):** 60 sequential calls per request, recording the call index at which each first fails and the exact error. `probe-r2-head` is `env.BUCKET.head` on a missing key; `probe-fetch` is the control (`HEAD https://example.com/`, no data sent); `probe-cache-match` is `caches.default.match`. This answers whether R2 binding calls on Free count against the 50-subrequest cap.

  - **Free account only.** The S1 probes are valid only on a Workers Free account. On Paid the 50 cap does not apply and every probe reads clean.
  - **Cache probe caveat.** The Cache API is documented as a no-op on `*.workers.dev`, so a clean `probe-cache-match` result there is inconclusive for "Cache API calls count against 50". It is meaningful only on a custom-domain route. The R2 and fetch probes are unaffected.

## Data, bindings, secrets

All data is synthetic (`d000123` ids, counter plus `x` padding), generated at build time by the tree's own code and bundled into `dist/worker.js`. `wrangler.jsonc` has no `account_id`, routes, vars or secrets. Its only binding is an **optional synthetic R2 bucket** `BUCKET` (`baerly-cpu-factor-synthetic`), used only by `probe-r2-head`: an empty bucket created for the run, never written to, deleted afterwards. Without it `probe-r2-head` reports `skipped` and the other cells are unaffected. The Worker makes outbound requests only for the `probe-fetch` control.

## Build and baseline (local)

```sh
pnpm bench:cpu-factor:build            # fixtures + dist/worker.js + out/cells.txt, from the current tree
pnpm bench:cpu-factor:node-baseline    # out/node-baseline.json; optional args: samples (default 200)
```

Run the baseline on a quiet machine. It records the load average before and after; the analyzer labels a loaded or unrecorded baseline **EXPLORATORY**, and a factor is a diagnostic comparison only. It never establishes a safe C/E by extrapolation. `dist/` and `out/` are gitignored.

## Owner: deploy, run, collect, delete

0. Auth: `./wrangler.sh` (in this directory) wraps `npx wrangler@4` and takes the token from `credentials/cloudflare-deploy-free.json` (`{ "api_token", "account_id" }`, gitignored; `CPU_FACTOR_TIER=paid` reads `cloudflare-deploy.json`), or from `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` if already set. No `wrangler login`. Mint a short-TTL account-owned token (Manage Account > API Tokens) on the one test account with:
   - **Workers Scripts: Edit**: `deploy` and `delete` the Worker (steps 3 and 9).
   - **Workers Tail: Read**: `tail` (step 4).
   - **Workers R2 Storage: Edit**: `r2 bucket create` / `delete` (steps 2 and 9). Workers roles do not cover R2. Required: `wrangler.jsonc` binds the bucket, so `deploy` fails without it.
   - **Account Settings: Read**: `whoami` (step 1).

   No zone permissions (no routes, workers.dev only). Revoke the token after step 9.

1. `./wrangler.sh whoami` and confirm the account is an **owner-approved test account on the Workers Free plan**. This bench uses synthetic data only; no company data goes to the account. The S1 probes are valid only on Free.
2. Create the empty synthetic bucket: `./wrangler.sh r2 bucket create baerly-cpu-factor-synthetic`.
3. From the repo root, `pnpm bench:cpu-factor:build` (wrangler deploys `dist/worker.js`, which nothing else builds). Then from `bench/cpu-factor-worker/`: `./wrangler.sh deploy`. The Worker gets a public `*.workers.dev` URL that serves only synthetic data. A run sends about 12,000 requests, within Free's 100,000 per day. Delete the Worker promptly.
4. Terminal 1: `./wrangler.sh tail baerly-cpu-factor-bench --format json > tail.json`.
5. Terminal 2: `./run-cells.sh https://baerly-cpu-factor-bench.<subdomain>.workers.dev 200` (about 20 minutes; S1 probe cells send 5 requests each). A `503` or error 1102 under a cell means the platform killed it for exceeding CPU; that is expected for large cells.
6. Wait about 10 seconds, stop the tail, and check `grep -c '"cpuTime"' tail.json`. If 0, export per-invocation CPU from the dashboard (Observability) as JSON with URL, outcome and `$workers.cpuTimeMs`, and save it as `observability.json`.
7. Strip the chosen capture to synthetic fields only (tail events also carry request headers and connection metadata). This normalizes both tail and Observability fields:

   ```sh
   capture=tail.json # use observability.json for the dashboard export
   jq -c '{
     outcome: (.outcome // ."$workers".outcome // null),
     cpuTime: (.cpuTime // .cpuTimeMs // ."$workers".cpuTimeMs // ."$metadata".cpuTimeMs),
     url: (.event.request.url // .request.url // ."$workers".event.request.url // .url),
     cell,
     logs: [.logs[]? | {message}]
   } | with_entries(select(.value != null))' "$capture" > cpu-factor-events.jsonl
   ```

8. Analyze locally: `pnpm bench:cpu-factor:node-baseline` (on a quiet machine; the analyzer reads `out/node-baseline.json`), then `pnpm bench:cpu-factor:analyze cpu-factor-events.jsonl`.

   For a preregistered capture, add `--prereg <file.json>` (see [Preregistered verdict](#preregistered-verdict)).

9. **Delete everything:** `./wrangler.sh delete baerly-cpu-factor-bench` and `./wrangler.sh r2 bucket delete baerly-cpu-factor-synthetic`. Confirm in the dashboard.
10. Return only `cpu-factor-events.jsonl` (bench URLs, outcomes, CPU times and the bench's own log lines) through an internal channel.

Run this deployment in the same window as any other S1 evidence, so both see the same platform conditions.

## Reading the output

- All CPU numbers (fold and tree cells) are warm-isolate: JIT-hot, with the first request per isolate dropped. Uniform `x` padding is a best case for JSON. Do not read p50 as a cold fold cost.
- Deployed `cpuTime` is authoritative; the in-isolate timer is a cross-check, since workerd clocks advance only across I/O.
- `Cold` invocations (first request in an isolate) and `&warmup=1` requests are dropped.
- A cell with 1% or more kills, or fewer than 50 ok samples, does not fit and is excluded from factors. Only fitting cells with measured deployed p99 at or below 8 ms can pass the C/E gate or establish a passing size; Node-derived estimates are diagnostic only.
- Probe lines show `completed`, the first failing call and the error text per run.

## Preregistered verdict

`pnpm bench:cpu-factor:analyze cpu-factor-events.jsonl --prereg my-prereg.json` checks the capture against a declaration made before the run. Copy `prereg.example.json` and fill in the owner's values; `sampleFloor` and `p99ThresholdMs` ship as `null` and the analyzer refuses a file that leaves them null or omits them. Fields:

- `decisionCells`: cell names that can decide the question. Each must be present in the capture.
- `sampleFloor`: minimum ok samples per decision cell.
- `p99ThresholdMs`: a decision cell passes only if its p99 is at or below this.
- `percentileMethod`: `nearest-rank` (the analyzer's default without `--prereg`) or `r7` (linear interpolation, Hyndman-Fan type 7). It applies to every percentile in the report, and the verdict names it.
- `capture`: `requestsPerCell` and `warmupsPerCell` (what `run-cells.sh` sends; checked against the events per decision cell) and `concurrency` (`xargs -P`; events do not record it, so it is printed as declared). Other keys are refused.

A decision cell passes iff it has no event missing a URL, outcome or CPU time, zero kills, zero `other` outcomes, at least `sampleFloor` ok samples and p99 at or below the threshold. The verdict passes iff at least one decision cell passes and nothing mismatches: an absent decision cell, request or warmup counts that differ from `capture`, an incomplete event in a decision cell, or an incomplete event that cannot be attributed to a cell each print a reason and make the run FAIL (exit 1). Without `--prereg` the output is unchanged.

## Not covered yet

Complete S3 and R2 query routes, retries and pages, and sustained-load and drain cells.
