/**
 * Maintenance-backlog-vs-write-rate probe — Phase 2 DECISIVE evidence.
 *
 * THE QUESTION. The "paid Workers are throttled at the free maintenance
 * rate" motivation rests entirely on one unmeasured claim: that
 * FREE-RATE maintenance FAILS to keep up within the prototype write
 * envelope (~30 writes/min/collection, the documented M-size ceiling —
 * see `M_SIZE_WRITES_PER_MIN_PER_COLLECTION` in
 * `packages/cli/src/admin/usage.ts`). This bench MEASURES that, per
 * trigger, and reports a clear verdict. It MEASURES ONLY — it changes no
 * production constant, profile value, or maintenance logic.
 *
 * TWO TRIGGERS, MEASURED SEPARATELY. baerly has exactly two maintenance
 * triggers (CLAUDE.md "Anti-patterns" / `maintenance.ts`):
 *
 *   - **in-band write-tick** (the sanctioned default): maintenance ticks
 *     on EVERY write via `runBoundedMaintenance`. Each tick can fold up
 *     to `maxFoldEntriesPerPass` (20 on CF-free) and GC is cadence-gated.
 *     Since each write adds ~1 live entry and each tick can fold 20,
 *     in-band intuitively keeps up EASILY — unless the fold DEFERS
 *     (snapshot over the `C` byte or `E` row ceiling) or GC sweep can't
 *     keep up with orphan production. This is the HEADLINE trigger.
 *
 *   - **scheduled / cron** (opt-in, models ~1 tick per simulated minute):
 *     `runScheduledMaintenance`, alternating compact / GC phases per tick
 *     (the CF even/odd-minute cron pattern). A compact tick folds ~20
 *     entries; at 30 writes/min producing ~30 entries/min while folding
 *     ~20 every OTHER minute, this is the trigger where free-rate counts
 *     can actually fall behind. This is the trigger the "throttled" story
 *     is really about.
 *
 * SIMULATED TIME. "writes/min" is the knob; a "minute" is purely a unit
 * that maps to `rate` writes (NO wall-clock claim — the bench runs in a
 * few seconds). One simulated minute = `rate` real `Db.collection()`
 * writes driven through the real `Writer` commit path. For the SCHEDULED
 * arm, exactly one `runScheduledMaintenance` tick fires per simulated
 * minute (the cron cadence); for the IN-BAND arm, maintenance ticks on
 * every write (the write-tick cadence) so the per-minute count is the
 * trajectory sample point, not a maintenance cadence.
 *
 * RATE GRID. {10, 30, 60, 120} writes/min/collection. 30 is the
 * documented M-size ceiling; 10 brackets it from below (a calm
 * prototype), 60 / 120 bracket it from above (2× / 4× over-envelope —
 * the "is the knob justified?" stress region).
 *
 * PROFILE ARM. CF-free (`MAINTENANCE_PROFILE_CF_FREE`) is the subject;
 * Node (`MAINTENANCE_PROFILE_NODE`, ~10× the per-pass caps) is a
 * comparison arm so the probe shows whether the higher Node counts change
 * the verdict.
 *
 * BACKLOG TRAJECTORY (recorded once per simulated minute):
 *   - `live_tail_entries` = `next_seq - log_seq_start` (un-folded log).
 *   - `object_count` = total bucket objects under the collection prefix.
 *   - `snapshot_bytes` / `snapshot_rows` (the fold ceiling axes).
 *   - `snapshot_over_ceiling` = whether the live snapshot is over the
 *     fold ceiling (`snapshot_bytes > C || snapshot_rows + slice > E`) —
 *     the same predicate the write-tick runner uses to DEFER a fold. A
 *     run that flips this true is folding into a snapshot the profile can
 *     no longer rebuild in one pass (the graduation signal).
 * The verdict per (trigger, rate, profile) is whether the backlog
 * converges to a BOUNDED steady state or GROWS without bound — judged
 * PER AXIS (`tail` and `objects`) and then combined. A cell is `bounded`
 * ONLY IF both axes are bounded; otherwise it is `growing`, annotated
 * with the offending axis (`growing (objects)` / `growing (tail)` /
 * `growing (tail+objects)`). The combined field is what a decision-maker
 * reads first, so it must mean "nothing is growing without bound" — a
 * cell whose tail drains every other fold but whose object count climbs
 * monotonically (a GC-drain backlog the large fold slice hides) is
 * `growing (objects)`, not `bounded`.
 *
 * GC GRACE. Production GC waits `GC_GRACE_PERIOD_MILLIS` (7 days) before
 * sweeping an orphan, so object-count drain is invisible in a few-second
 * bench. Like `maintenance-profile-equivalence.test.ts`, this bench uses
 * the `gcGraceMillis: 0` test seam (in-band) / `graceMillis: 0`
 * (scheduled) so a marked orphan is sweepable the same pass — making the
 * steady-state object-count trajectory observable WITHOUT an 8-day clock
 * advance. This models the drain CEILING (does sweep throughput keep up
 * with orphan production `p`?), not the 7-day-delayed production timing.
 *
 * WORKLOAD. A bounded working set churned by update / delete-reinsert, so
 * the LIVE row set stays ~constant while the tail and orphan content
 * grow — the realistic prototype shape (a notes/tickets app), and the
 * shape that makes the `WRITE_TICK_GC_MAX_SWEEPS / WRITE_TICK_GC_INTERVAL
 * (= 10/4) >= p` drain-rate invariant (graduation.md §7.1) load-bearing:
 * each update/delete orphans one prior content blob, so orphan-production
 * rate `p` ~ writes, and GC must sweep >= `p` per write to stay bounded.
 *
 * DOC SIZE. `BODY_BYTES = 2000` (matches the equivalence test). With 2 KB
 * docs the tail reaches the 64 KB `MAINTENANCE_MIN_LIVE_BYTES` first-fold
 * threshold in ~32 entries, so folds actually fire inside the bench
 * window — a smaller doc would never trip the ratio gate and every rate
 * would look (falsely) identical.
 *
 * OUTPUT. One JSON file per run to `bench/results/maintenance-backlog/`;
 * a representative baseline is checked in at
 * `docs/spec/attachments/maintenance-backlog-baseline.json`.
 *
 * Reproduction: `pnpm bench:maintenance-backlog`. No infra
 * (MemoryStorage). Numbers are deterministic BY CONSTRUCTION — the op
 * stream is index-derived and profile-independent (it never consumes
 * `SEED`; the constant is an informational reproduction handle only).
 * The verdict shape is the portable signal.
 */

/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol`'s `Collection<T>`). */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  type DocumentData,
  GC_STARVATION_GUARD,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_NODE,
  MAINTENANCE_TARGET_RATIO,
  MAINTENANCE_MIN_LIVE_BYTES,
  MemoryStorage,
  createCurrentJson,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import {
  type BoundedMaintenanceOptions,
  type MaintenanceProfile,
  runScheduledMaintenance,
} from "@baerly/server/maintenance";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import { type InternalMaintenanceOptions, Writer } from "@baerly/server/_internal/testing";

// ── Bench config. Pinned — tweak in source if needed. ────────────────

const SEED = 0xbac_106; // "backlog"; reproduction handle (informational).
const APP = "app";
const TENANT = "tenant";
const COLLECTION = "tickets";
const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLLECTION}`;
const CURRENT_JSON_KEY = `${TABLE_PREFIX}/current.json`;

/**
 * Write-rate grid (writes/min/collection). 30 = the documented M-size
 * ceiling (`M_SIZE_WRITES_PER_MIN_PER_COLLECTION`); 10 brackets below,
 * 60 / 120 bracket above (2× / 4× over-envelope).
 */
const RATE_GRID: readonly number[] = [10, 30, 60, 120];

/** Simulated minutes per (trigger, rate, profile) cell. */
const SIM_MINUTES = 30;

/** Bounded live working set — keeps the live row floor ~constant. */
const WORKING_SET = 50;

/** Doc body bytes; big enough that the ratio gate trips and folds fire. */
const BODY_BYTES = 2000;

/** Min-entries floor matching the write-tick profile default. */
const MIN_ENTRIES_TO_COMPACT = 50;

interface ProfileCase {
  readonly label: "cf-free" | "node";
  readonly profile: MaintenanceProfile;
  /**
   * The phase policy this host runs in PRODUCTION for the in-band tick —
   * CF-free is `"single"` (worker.ts: a CPU-killable free isolate does ONE
   * of fold/GC per request), Node is `"both"` (server.ts). The bench must
   * use each host's real policy or it measures a schedule that doesn't ship.
   */
  readonly phasesPerTick: "single" | "both";
}
const PROFILE_CASES: readonly ProfileCase[] = [
  { label: "cf-free", profile: MAINTENANCE_PROFILE_CF_FREE, phasesPerTick: "single" },
  { label: "node", profile: MAINTENANCE_PROFILE_NODE, phasesPerTick: "both" },
];

// ── Workload generation ──────────────────────────────────────────────

interface Doc extends DocumentData {
  _id: string;
  status: "open" | "closed";
  rev: number;
  /** Pad sized to `BODY_BYTES` so each entry's tail bytes are realistic. */
  blob: string;
}

interface Op {
  readonly op: "I" | "U" | "D";
  readonly docId: string;
  readonly body?: Doc;
}

/**
 * Deterministic, profile-independent op stream over a bounded id space.
 * A mix of insert / update / delete-then-reinsert that keeps the LIVE set
 * ~constant (so the snapshot row count plateaus) while the tail churns —
 * every U / D supersedes a prior content blob, producing the orphans GC
 * must reclaim. `total` ops are generated up front; the simulation slices
 * `rate` of them per simulated minute.
 */
const buildOps = (total: number): readonly Op[] => {
  const blob = "x".repeat(BODY_BYTES);
  const ops: Op[] = [];
  for (let i = 0; i < total; i++) {
    const docId = `d${(i % WORKING_SET).toString().padStart(4, "0")}`;
    // After the first lap, every 13th op deletes its doc; a later op on
    // the same id re-inserts it (delete/re-insert churn → orphans).
    if (i >= WORKING_SET && i % 13 === 0) {
      ops.push({ op: "D", docId });
    } else {
      ops.push({
        op: i % 2 === 0 ? "I" : "U",
        docId,
        body: {
          _id: docId,
          status: i % 3 === 0 ? "closed" : "open",
          rev: Math.floor(i / WORKING_SET),
          blob,
        },
      });
    }
  }
  return ops;
};

const commitOp = async (writer: Writer, o: Op): Promise<void> => {
  if (o.op === "D") {
    await writer.commit({ op: "D", collection: COLLECTION, docId: o.docId });
  } else {
    await writer.commit({ op: o.op, collection: COLLECTION, docId: o.docId, body: o.body! });
  }
};

// ── Backlog observation ──────────────────────────────────────────────

interface MinuteSample {
  readonly minute: number;
  readonly cumulative_writes: number;
  readonly live_tail_entries: number;
  readonly object_count: number;
  readonly snapshot_bytes: number;
  readonly snapshot_rows: number;
  /**
   * Whether the live snapshot is currently OVER the fold ceiling — the
   * same `snapshot_bytes > C || snapshot_rows + slice > E` predicate the
   * write-tick runner uses to DEFER a fold (`runBoundedMaintenance` Step
   * 3). A run that ever flips this true is folding into a snapshot the
   * profile can no longer rebuild in one pass — the graduation signal.
   */
  readonly snapshot_over_ceiling: boolean;
}

const countObjects = async (storage: Storage): Promise<number> => {
  let n = 0;
  for await (const _entry of storage.list(TABLE_PREFIX)) {
    n++;
  }
  return n;
};

const sampleBacklog = async (
  storage: Storage,
  minute: number,
  cumulativeWrites: number,
  profile: MaintenanceProfile,
): Promise<MinuteSample> => {
  const cur = (await readCurrentJson(storage, CURRENT_JSON_KEY))!.json;
  const overCeiling =
    cur.snapshot_bytes > profile.maxFoldBytes ||
    cur.snapshot_rows + profile.maxFoldEntriesPerPass > profile.maxFoldRows;
  return {
    minute,
    cumulative_writes: cumulativeWrites,
    live_tail_entries: cur.next_seq - cur.log_seq_start,
    object_count: await countObjects(storage),
    snapshot_bytes: cur.snapshot_bytes,
    snapshot_rows: cur.snapshot_rows,
    snapshot_over_ceiling: overCeiling,
  };
};

const bootstrap = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "maintenance-backlog-bench", claimed_at: "" },
    tail_bytes: 0,
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

// ── In-band scenario ─────────────────────────────────────────────────

/**
 * Drive the real write-tick path: every commit ticks
 * `runBoundedMaintenance` at `profile`, via the writer's post-CAS dispatch
 * inside an ALS maintenance scope. `phasesPerTick` is each host's REAL
 * production policy (CF-free `"single"`, Node `"both"`) — not a uniform
 * choice — so the verdict reflects what actually ships. `gcGraceMillis: 0`
 * makes orphan sweep observable in-window (see head comment).
 */
const runInBand = async (
  profile: MaintenanceProfile,
  rate: number,
  phasesPerTick: "single" | "both",
): Promise<readonly MinuteSample[]> => {
  const storage = new MemoryStorage();
  await bootstrap(storage);
  const ops = buildOps(rate * SIM_MINUTES);
  const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
  const maintenance = {
    options: {
      profile,
      minEntriesToCompact: MIN_ENTRIES_TO_COMPACT,
      phasesPerTick,
      gcGraceMillis: 0,
    } satisfies BoundedMaintenanceOptions,
  };
  const samples: MinuteSample[] = [];
  let cursor = 0;
  await runWithContext(createObservabilityContext({ maintenance }), async () => {
    for (let minute = 1; minute <= SIM_MINUTES; minute++) {
      for (let k = 0; k < rate; k++) {
        await commitOp(writer, ops[cursor++]!);
      }
      samples.push(await sampleBacklog(storage, minute, cursor, profile));
    }
  });
  return samples;
};

// ── Scheduled scenario ───────────────────────────────────────────────

/**
 * Drive writes with the in-band tick DISABLED, then fire exactly one
 * `runScheduledMaintenance` tick per simulated minute — alternating
 * compact (even minute) and GC (odd minute), the CF even/odd-minute cron
 * pattern. The compact tick is capped at the profile's
 * `maxFoldEntriesPerPass`; GC at the profile's mark/sweep caps. This is
 * the trigger the "throttled" story is about: ~20 folded per compact
 * tick vs `rate` entries produced per minute.
 */
const runScheduled = async (
  profile: MaintenanceProfile,
  rate: number,
): Promise<readonly MinuteSample[]> => {
  const storage = new MemoryStorage();
  await bootstrap(storage);
  const ops = buildOps(rate * SIM_MINUTES);
  // Writer with the in-band tick disabled — the scheduled tick is the
  // ONLY maintenance trigger in this arm.
  const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
  const samples: MinuteSample[] = [];
  let cursor = 0;
  await runWithContext(
    createObservabilityContext({ maintenance: { disabled: true } }),
    async () => {
      for (let minute = 1; minute <= SIM_MINUTES; minute++) {
        for (let k = 0; k < rate; k++) {
          await commitOp(writer, ops[cursor++]!);
        }
        // One scheduled tick this minute — alternate phases like the CF
        // even/odd-minute cron. `graceMillis: 0` so a GC tick sweeps the
        // orphans it marks the same pass (in-window observability).
        const phase = minute % 2 === 0 ? "compact" : "gc";
        const opts: InternalMaintenanceOptions =
          phase === "compact"
            ? {
                compact: {
                  maxEntriesPerRun: profile.maxFoldEntriesPerPass,
                  minEntriesToCompact: MIN_ENTRIES_TO_COMPACT,
                },
                // GC budget zeroed this tick — compact-only phase.
                gc: { maxMarksPerRun: 0, maxSweepsPerRun: 0, graceMillis: 0 },
              }
            : {
                // Compact disabled this tick (min threshold unreachable) — GC-only.
                compact: { maxEntriesPerRun: 0, minEntriesToCompact: Number.MAX_SAFE_INTEGER },
                gc: {
                  maxMarksPerRun: profile.gcMaxMarks,
                  maxSweepsPerRun: profile.gcMaxSweeps,
                  graceMillis: 0,
                },
              };
        await runScheduledMaintenance({ storage, currentJsonKey: CURRENT_JSON_KEY }, opts);
        samples.push(await sampleBacklog(storage, minute, cursor, profile));
      }
    },
  );
  return samples;
};

// ── Verdict ──────────────────────────────────────────────────────────

type AxisVerdict = "bounded" | "growing";
/**
 * The combined verdict a decision-maker reads first. `bounded` ONLY IF
 * both measured axes (tail + objects) are bounded; otherwise `growing`,
 * annotated with the offending axis.
 */
type Verdict = "bounded" | "growing (tail)" | "growing (objects)" | "growing (tail+objects)";

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * TAIL axis. Classify the live-tail trajectory bounded vs growing by
 * comparing the mean of the first third of the run to the last third. A
 * tail not meaningfully larger at the end is bounded (converged to steady
 * state); one that keeps climbing is growing. Threshold: last-third mean
 * > 1.5× first-third mean AND grew by more than one fold slice — avoids
 * calling normal fold sawtooth "growing". The tail starts near its steady
 * state (it is `next_seq - log_seq_start`, not a cold-bucket count), so
 * the first third is representative and first-vs-last is sound here.
 */
const classifyTail = (samples: readonly MinuteSample[], foldSlice: number): AxisVerdict => {
  const n = samples.length;
  const third = Math.max(1, Math.floor(n / 3));
  const early = mean(samples.slice(0, third).map((s) => s.live_tail_entries));
  const late = mean(samples.slice(n - third).map((s) => s.live_tail_entries));
  return late > early * 1.5 && late - early > foldSlice ? "growing" : "bounded";
};

/**
 * OBJECTS axis. Same first-third-vs-last-third FRAMING, but two
 * deliberate differences from the tail test — the object-count axis
 * genuinely needs them:
 *
 *  1. Compare the SECOND third (mid) to the last third, NOT the first.
 *     `object_count` starts at 0 on a cold bucket and ramps through a
 *     warm-up before reaching steady state, so the first third is an
 *     unrepresentative cold-start ramp — a first-vs-last ratio would
 *     mislabel a bucket that warmed up then plateaued (e.g. in-band
 *     cf-free, 22→~170 then flat) as "growing". The tail has no such
 *     ramp, so it keeps the first-vs-last window.
 *  2. Use an ADDITIVE floor (`grew > WORKING_SET`) with NO 1.5× ratio
 *     gate. A slow monotonic climb on a large post-warm-up baseline
 *     (scheduled/node at the M-size envelope: ~8 objects/min that never
 *     plateaus) is a genuine unbounded GC-drain backlog even when the
 *     30-minute window isn't long enough to reach 1.5×; the ratio gate
 *     would wrongly absolve it. `WORKING_SET` is the right floor because
 *     the bounded steady-state object count oscillates within a band set
 *     by the live working set, so growth below one working-set is fold
 *     sawtooth noise, not a backlog.
 */
const classifyObjects = (samples: readonly MinuteSample[]): AxisVerdict => {
  const n = samples.length;
  const third = Math.max(1, Math.floor(n / 3));
  const mid = mean(samples.slice(third, 2 * third).map((s) => s.object_count));
  const late = mean(samples.slice(n - third).map((s) => s.object_count));
  return late - mid > WORKING_SET ? "growing" : "bounded";
};

const combineVerdict = (tail: AxisVerdict, objects: AxisVerdict): Verdict => {
  if (tail === "bounded" && objects === "bounded") {
    return "bounded";
  }
  if (tail === "growing" && objects === "growing") {
    return "growing (tail+objects)";
  }
  return tail === "growing" ? "growing (tail)" : "growing (objects)";
};

interface CellResult {
  readonly trigger: "in-band" | "scheduled";
  readonly profile: "cf-free" | "node";
  readonly rate: number;
  /** Per-axis verdicts on the two measured backlog axes. */
  readonly tail_verdict: AxisVerdict;
  readonly objects_verdict: AxisVerdict;
  /** Combined verdict: `bounded` only if BOTH axes are bounded. */
  readonly verdict: Verdict;
  /** Last-minute backlog snapshot — the steady-state (or runaway) tail. */
  readonly final_live_tail_entries: number;
  readonly final_object_count: number;
  readonly final_snapshot_rows: number;
  /** Count of minutes the snapshot was over the fold ceiling (would-defer). */
  readonly minutes_over_ceiling: number;
  /** Peak live-tail over the whole run (worst backlog observed). */
  readonly peak_live_tail_entries: number;
  readonly samples: readonly MinuteSample[];
}

interface RunResult {
  readonly schema_version: 1;
  readonly bench: "maintenance-backlog";
  readonly description: string;
  readonly seed: number;
  readonly sim_minutes: number;
  readonly working_set: number;
  readonly body_bytes: number;
  readonly min_entries_to_compact: number;
  readonly rate_grid: readonly number[];
  readonly methodology: {
    readonly simulated_time: string;
    readonly gc_grace: string;
    readonly in_band: string;
    readonly scheduled: string;
    readonly tail_verdict: string;
    readonly objects_verdict: string;
    readonly verdict: string;
  };
  readonly invariants: {
    readonly maintenance_target_ratio: number;
    readonly maintenance_min_live_bytes: number;
    readonly gc_starvation_guard: number;
    readonly cf_free_drain_ratio: string;
    readonly node_drain_ratio: string;
  };
  readonly cells: readonly CellResult[];
  readonly timestamp_iso: string;
  readonly node_version: string;
  readonly platform: string;
  readonly arch: string;
}

const main = async (): Promise<number> => {
  const startedAt = Date.now();
  const cells: CellResult[] = [];

  const runners: ReadonlyArray<{
    trigger: "in-band" | "scheduled";
    run: (pc: ProfileCase, r: number) => Promise<readonly MinuteSample[]>;
  }> = [
    // In-band uses each host's real phase policy; scheduled alternates
    // compact/GC explicitly and ignores phasesPerTick.
    { trigger: "in-band", run: (pc, r) => runInBand(pc.profile, r, pc.phasesPerTick) },
    { trigger: "scheduled", run: (pc, r) => runScheduled(pc.profile, r) },
  ];

  for (const { trigger, run } of runners) {
    for (const pc of PROFILE_CASES) {
      for (const rate of RATE_GRID) {
        const samples = await run(pc, rate);
        const last = samples[samples.length - 1]!;
        const peakTail = samples.reduce((m, s) => Math.max(m, s.live_tail_entries), 0);
        const tailVerdict = classifyTail(samples, pc.profile.maxFoldEntriesPerPass);
        const objectsVerdict = classifyObjects(samples);
        cells.push({
          trigger,
          profile: pc.label,
          rate,
          tail_verdict: tailVerdict,
          objects_verdict: objectsVerdict,
          verdict: combineVerdict(tailVerdict, objectsVerdict),
          final_live_tail_entries: last.live_tail_entries,
          final_object_count: last.object_count,
          final_snapshot_rows: last.snapshot_rows,
          minutes_over_ceiling: samples.filter((s) => s.snapshot_over_ceiling).length,
          peak_live_tail_entries: peakTail,
          samples,
        });
      }
    }
  }

  const cfDrain = MAINTENANCE_PROFILE_CF_FREE.gcMaxSweeps / MAINTENANCE_PROFILE_CF_FREE.gcInterval;
  const nodeDrain = MAINTENANCE_PROFILE_NODE.gcMaxSweeps / MAINTENANCE_PROFILE_NODE.gcInterval;

  const result: RunResult = {
    schema_version: 1,
    bench: "maintenance-backlog",
    description:
      "Backlog (live tail entries + object count + snapshot-over-ceiling) vs write rate, per maintenance " +
      "trigger (in-band write-tick / scheduled cron) and profile (cf-free / node). Measures whether " +
      "FREE-RATE maintenance keeps up within the ~30 writes/min M-size envelope. Measures only.",
    seed: SEED,
    sim_minutes: SIM_MINUTES,
    working_set: WORKING_SET,
    body_bytes: BODY_BYTES,
    min_entries_to_compact: MIN_ENTRIES_TO_COMPACT,
    rate_grid: RATE_GRID,
    methodology: {
      simulated_time:
        "writes/min is the knob; a 'minute' is a unit mapping to `rate` real Db writes — NO wall-clock claim (the bench runs in seconds)",
      gc_grace:
        "gcGraceMillis/graceMillis = 0 so a marked orphan sweeps the same pass — models the drain CEILING (sweep throughput vs orphan production p), not the 7-day-delayed production timing",
      in_band:
        "every commit ticks runBoundedMaintenance at the profile; phasesPerTick matches each host's PRODUCTION policy — cf-free 'single' (worker.ts), node 'both' (server.ts)",
      scheduled:
        "in-band disabled; one runScheduledMaintenance tick per simulated minute, alternating compact (even) / GC (odd) — the CF even/odd-minute cron pattern",
      tail_verdict:
        "live_tail_entries axis: bounded = last-third mean not > 1.5x first-third mean AND grew <= one fold slice (converged sawtooth); growing = climbs past both. First-vs-last is sound here because the tail starts near steady state (no cold-bucket ramp).",
      objects_verdict:
        "object_count axis: same thirds framing but (1) MID-third vs last-third — object_count ramps from 0 on a cold bucket, so the first third is unrepresentative warm-up; (2) additive floor only (grew > working_set), no 1.5x ratio gate — a slow monotonic climb on a large baseline that never plateaus is a genuine unbounded GC-drain backlog even below 1.5x, and working_set is the steady-state oscillation band below which growth is fold sawtooth noise.",
      verdict:
        "combined: bounded ONLY IF both axes bounded; else growing, annotated with the offending axis — growing (tail) / growing (objects) / growing (tail+objects). This is the field a decision reads first, so it means 'nothing is growing without bound'.",
    },
    invariants: {
      maintenance_target_ratio: MAINTENANCE_TARGET_RATIO,
      maintenance_min_live_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      gc_starvation_guard: GC_STARVATION_GUARD,
      cf_free_drain_ratio: `gcMaxSweeps/gcInterval = ${MAINTENANCE_PROFILE_CF_FREE.gcMaxSweeps}/${MAINTENANCE_PROFILE_CF_FREE.gcInterval} = ${cfDrain} (>= orphan-production p keeps object count bounded — graduation.md §7.1)`,
      node_drain_ratio: `gcMaxSweeps/gcInterval = ${MAINTENANCE_PROFILE_NODE.gcMaxSweeps}/${MAINTENANCE_PROFILE_NODE.gcInterval} = ${nodeDrain}`,
    },
    cells,
    timestamp_iso: new Date(startedAt).toISOString(),
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
  };

  const outDir = "bench/results/maintenance-backlog";
  await mkdir(outDir, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const out = path.join(outDir, `maintenance-backlog-${stamp}.json`);
  await writeFile(out, JSON.stringify(result, null, 2));

  // ── Summary table ───────────────────────────────────────────────────
  console.log(
    "trigger     profile   rate  tail      objects   verdict                 finalTail  peakTail  objs  snapRows  overCeil",
  );
  for (const c of cells) {
    console.log(
      `${c.trigger.padEnd(11)} ${c.profile.padEnd(8)} ${c.rate.toString().padStart(4)}  ` +
        `${c.tail_verdict.padEnd(9)} ${c.objects_verdict.padEnd(9)} ${c.verdict.padEnd(23)} ` +
        `${c.final_live_tail_entries.toString().padStart(9)} ` +
        `${c.peak_live_tail_entries.toString().padStart(8)} ` +
        `${c.final_object_count.toString().padStart(5)} ` +
        `${c.final_snapshot_rows.toString().padStart(8)} ` +
        `${c.minutes_over_ceiling.toString().padStart(8)}`,
    );
  }
  console.log(`\nwrote ${out}`);
  return 0;
};

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
