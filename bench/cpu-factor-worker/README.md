# Deployed workerd CPU bench

An owner-deployed Cloudflare Worker that measures, on a real Workers account, per-invocation CPU (`cpuTime`) and outcomes for three groups of cells. Nothing here runs in `pnpm verify` or `pnpm test` beyond the analyzer unit test.

- **Fold cells:** the current tree's fold invocation (a write that reaches the fold, then one `compact()` pass at the Cloudflare Free options) over synthetic fixtures, plus the original factor subject (`subject-*`). They give the deployed/Node factor.
- **Tree fold-step cells (`tree-k<k>-b<B>-d<d>`):** a synthetic step on a content-addressed tree: re-encode `k` leaves (JSON) of about `B` KiB, SHA-256 each with `crypto.subtle.digest`, then re-encode and hash `d` path nodes. Grid: k in {1,2,4,8}, B in {4,16,64} KiB, d in {1,2,3}. The `d` nodes are one shared path (best case); leaves on distinct paths touch up to `k*d` nodes. The report says how many leaves fit under Free's ~10 ms, measured directly with no factor involved.
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

The earlier scratch version carried a `policy-switch.patch` and two prepared source trees for chunked layouts. They are gone: the Worker builds the tree it sits in, and there is a single fold layout.

## Owner: deploy, run, collect, delete

1. `npx wrangler@4 whoami` and confirm the **company-managed Cloudflare account**, never a personal one. For a final Free claim use a Workers Free account; Paid needs an appropriate company-managed Paid account.
2. Create the empty synthetic bucket: `npx wrangler@4 r2 bucket create baerly-cpu-factor-synthetic`.
3. From `bench/cpu-factor-worker/`: `npx wrangler@4 deploy`. The Worker gets a public `*.workers.dev` URL that serves only synthetic data. A run sends about 12,000 requests, within Free's 100,000 per day. Delete the Worker promptly.
4. Terminal 1: `npx wrangler@4 tail baerly-cpu-factor-bench --format json > tail.json`.
5. Terminal 2: `./run-cells.sh https://baerly-cpu-factor-bench.<subdomain>.workers.dev 200` (about 20 minutes; S1 probe cells send 5 requests each). A `503` or error 1102 under a cell means the platform killed it for exceeding CPU; that is expected for large cells.
6. Wait about 10 seconds, stop the tail, and check `grep -c '"cpuTime"' tail.json`. If 0, export per-invocation CPU from the dashboard (Observability) as JSON with URL, outcome and `$workers.cpuTimeMs`, and save it as `observability.json`.
7. Strip the chosen capture to synthetic fields only (tail events also carry request headers and connection metadata). This normalizes both tail and Observability fields:

   ```sh
   capture=tail.json # use observability.json for the dashboard export
   jq -c '{
     outcome: (.outcome // ."$workers".outcome // "ok"),
     cpuTime: (.cpuTime // .cpuTimeMs // ."$workers".cpuTimeMs // ."$metadata".cpuTimeMs),
     url: (.event.request.url // .request.url // ."$workers".event.request.url // .url),
     cell,
     logs: [.logs[]? | {message}]
   } | with_entries(select(.value != null))' "$capture" > cpu-factor-events.jsonl
   ```

8. Analyze locally: `pnpm bench:cpu-factor:analyze cpu-factor-events.jsonl`.
9. **Delete everything:** `npx wrangler@4 delete baerly-cpu-factor-bench` and `npx wrangler@4 r2 bucket delete baerly-cpu-factor-synthetic`. Confirm in the dashboard.
10. Return only `cpu-factor-events.jsonl` (bench URLs, outcomes, CPU times and the bench's own log lines) through an internal channel.

Run this deployment in the same window as any other S1 evidence, so both see the same platform conditions.

## Reading the output

- All CPU numbers (fold, subject and tree cells) are warm-isolate: JIT-hot, with the first request per isolate dropped. Uniform `x` padding is a best case for JSON. Do not read p50 as a cold fold cost.
- Deployed `cpuTime` is authoritative; the in-isolate timer is a cross-check, since workerd clocks advance only across I/O.
- `Cold` invocations (first request in an isolate) and `&warmup=1` requests are dropped.
- A cell with 1% or more kills, or fewer than 50 ok samples, does not fit and is excluded from factors. Only fitting cells with measured deployed p99 at or below 8 ms can pass the C/E gate or establish a passing size; Node-derived estimates are diagnostic only.
- Probe lines show `completed`, the first failing call and the error text per run.

## Not covered yet

Complete S3 and R2 query routes, retries and pages, and sustained-load and drain cells.
