export type WorkloadCeilingReadShape = "point" | "bounded-range" | "index-routed" | "complete";

export type WorkloadCeilingEvidenceSource = "deployed-workers" | "node" | "miniflare";

export type WorkloadCeilingEvidenceProfile = "cf-free" | "cf-paid" | "node";

/**
 * The Workers billing plan the evidence was captured on.
 *
 * Recorded separately from `WorkloadCeilingEvidenceProfile` because the two
 * are NOT the same fact and the study learned that the expensive way: a
 * confirmed Workers Free account does not deliver the cf-free CPU envelope
 * (see `cpu_envelope` below). The profile names the envelope the fold ran
 * under; the plan names who was billed.
 */
export type WorkloadCeilingWorkersPlan = "workers-free" | "workers-paid";

export type WorkloadCeilingStatistic = "p50" | "p95" | "p99";

/**
 * Fixed input space for the unreleased chunked-snapshot study. This contract is
 * measurement-only: it does not change a shipped ceiling or production export.
 */
export interface WorkloadCeilingStudyContract {
  readonly id: "baerly.workload-ceiling/chunked-snapshot/v1";
  readonly collection_bytes: readonly number[];
  readonly collection_rows: readonly number[];
  readonly document_bytes: readonly number[];
  readonly changed_byte_fractions: readonly number[];
  readonly mutation_localities: readonly ["hot-key", "uniform"];
  readonly mutation_mixes: readonly {
    readonly id: string;
    readonly insert: number;
    readonly update: number;
    readonly delete: number;
  }[];
  readonly manifest_descriptors: readonly number[];
  readonly read_shapes: readonly ["point", "bounded-range", "index-routed", "complete"];
  readonly read_fan_out_limits: Readonly<Record<WorkloadCeilingReadShape, number>>;
  /** Independent fixtures prevent the byte and row fold gates from being conflated. */
  readonly axis_sweeps: {
    readonly byte_axis: {
      readonly document_bytes: 2048;
      readonly collection_bytes_measure: "encoded-snapshot-bytes";
    };
    readonly row_axis: {
      readonly document_bytes: 256;
      readonly collection_rows_measure: "rows";
    };
  };
  readonly minimum_useful_targets: {
    readonly byte_axis: {
      readonly collection_bytes: number;
      readonly document_bytes: 2048;
    };
    readonly row_axis: {
      readonly collection_rows: number;
      readonly document_bytes: 256;
    };
  };
  readonly admission: {
    readonly primary_profile: "cf-free";
    readonly requires_deployed_workers: true;
    readonly requires_zero_failures_upper_bound: true;
    /** Every planned measured invocation must have exactly one authoritative event (see `capture.telemetry`). */
    readonly requires_complete_evidence: true;
    /** Finite successful CPU samples per cell/arm must meet `capture.cpu_sample_floor_per_cell`. */
    readonly requires_cpu_sample_floor: true;
    readonly required_statistics: readonly ["p50", "p95", "p99"];
    readonly requires_repeated_tail_drain: true;
    readonly accepted_evidence_sources: readonly ["deployed-workers"];
  };
  /**
   * How the `cf-free` CPU envelope is obtained, fixed before any sample.
   *
   * The study originally assumed the envelope came with the account: deploy
   * to a Workers Free account and the platform enforces 10 ms. The
   * 2026-08-21 plancheck falsified that on an account whose Free plan was
   * confirmed from both the dashboard and the billing API — ten consecutive
   * 4 MiB folds measured 23–66 ms CPU with zero `exceededCpu`.
   *
   * That is documented platform behavior, not an account anomaly. Cloudflare
   * states of the CPU limit: "Each isolate has some built-in flexibility to
   * allow for cases where your Worker infrequently runs over the configured
   * limit. If your Worker starts hitting the limit consistently, its
   * execution will be terminated according to the limit configured."
   * Enforcement is elastic and duty-cycle dependent. The capture protocol's
   * own `invocation_spacing_seconds: 70` is the most lenient duty cycle
   * available, so a spaced capture is the case least likely to trip it.
   *
   * The envelope is therefore obtained by CONFIGURATION, never by plan
   * selection: `limits.cpu_ms` in `bench/workload-ceiling-worker/wrangler.jsonc`,
   * set to `cf_free_cpu_ms`. That setting requires the Standard Usage Model,
   * i.e. Workers Paid — so `cf-free` evidence is captured on a PAID plan with
   * the free ceiling configured, which is a stricter and more reproducible
   * environment than a free account that does not enforce.
   *
   * `satisfiesWorkloadCeilingAdmission` enforces this: `cf-free` evidence
   * must carry `configured_cpu_ms === cf_free_cpu_ms`, whatever the plan. A
   * capture on an unconfigured account — free or paid — is not `cf-free`
   * evidence, which is exactly the mistake this field exists to prevent.
   */
  readonly cpu_envelope: {
    /** Workers Free's documented per-invocation CPU limit, in milliseconds. */
    readonly cf_free_cpu_ms: 10;
    /** Platform enforcement semantics, as documented. Not per-invocation. */
    readonly enforcement: "elastic-duty-cycle-dependent";
    /** The envelope comes from `limits.cpu_ms`, not from the billing plan. */
    readonly obtained_by: "configured-limit";
  };
  /**
   * The capture protocol, fixed BEFORE any sample is taken.
   *
   * `statistics.ts` deliberately owns no sample count, retry rule, or
   * threshold — those are study policy, and study policy chosen after seeing
   * data is not preregistration. Every field here is consumed by the Lane B/C/D
   * capture runner and re-asserted by the aggregator, so a run that silently
   * deviates fails rather than quietly reports.
   */
  readonly capture: {
    /**
     * Measured invocations PLANNED per cell per arm — the count the capture
     * runner invokes and the journal records.
     *
     * This is `cpu_sample_floor_per_cell` plus a fixed telemetry-drop
     * margin, preregistered after the 2026-08-24 rehearsal measured
     * `workersInvocationsAdaptive` permanently dropping ~4 of 24 rows
     * (while Workers Observability held 24/24). At the observed 15 % drop
     * rate, 40 planned invocations keep ≥ 30 CPU samples with ≈ 98 %
     * probability per cell-arm. The margin replaces the contradictory
     * post-hoc top-up: attempts are added BEFORE capture, here, never
     * after observing missingness. A cell that still lands short fails CPU
     * completeness and blocks admission — it is never topped up.
     */
    readonly planned_measured_invocations_per_cell: 40;
    /**
     * Minimum finite CPU samples on successful invocations per cell per arm.
     *
     * 30 is the statistical floor, not a target: at n = 30 the R-7
     * estimator's p99 lands at h = (n-1)·0.99 = 28.71, i.e. it interpolates
     * between the two largest order statistics and is effectively the sample
     * maximum. That is an honest p99 for a 30-sample cell and it is reported
     * with its `sample_size` (`statistics.ts` carries the field for exactly
     * this reason), but it is NOT a tail estimate in the sense a 100+ sample
     * cell would give. An admission decision that turns on the tail must
     * raise this floor and re-capture; it must never reinterpret a
     * 30-sample p99 as something it is not.
     *
     * The floor counts finite CPU measurements on SUCCESSFUL invocations
     * only — a `workersInvocationsAdaptive` row that never landed is
     * CPU-measurement missingness (see `telemetry`), not a failed
     * invocation, but it still leaves the cell short of this floor.
     */
    readonly cpu_sample_floor_per_cell: 30;
    /**
     * Discarded invocations per cell per arm, taken before the measured ones
     * and excluded by tag, never by looking at their values.
     *
     * Two, because the first invocation against a freshly provisioned fixture
     * pays R2's first-read latency for those keys and the second is the first
     * that can hit a warm isolate. Both are excluded for being *first*, a
     * property known before the run.
     */
    readonly warmup_invocations_per_cell: 2;
    /**
     * Minimum seconds between ANY two invocations of the study Worker, across
     * every cell and arm.
     *
     * `workersInvocationsAdaptive` groups by a minute-resolution `datetime`
     * dimension: two invocations inside one bucket collapse to a single row
     * with `requests: 2`, which the collector records as CPU-measurement
     * missingness for both rather than guessing. Any two instants ≥ 60 s
     * apart are necessarily in different buckets; 70 gives clock-skew
     * headroom without materially lengthening the run.
     *
     * This is a GLOBAL spacing. All arms and cells share the one fixed-name
     * script, so the constraint is per-Worker, not per-cell.
     */
    readonly invocation_spacing_seconds: 70;
    /**
     * Seconds to wait after the last invocation before the FIRST telemetry
     * collection pass.
     *
     * Neither telemetry source is read-your-writes. Collecting too early
     * records evidence that is merely lagging as missing — which blocks
     * evidence completeness exactly like a genuinely absent record, so the
     * settle delay plus the one fixed retry below exist to make "missing"
     * mean missing.
     */
    readonly telemetry_settle_seconds: 600;
    /**
     * The ONLY sanctioned exclusion. An invocation is excluded if and only if
     * it carries this tag, assigned before it ran.
     *
     * There is deliberately no post-hoc outlier rule, no re-roll of an
     * unresolved sample, and no top-up: an invocation whose authoritative
     * record never resolves stays in the record with a `missing` evidence
     * status and blocks the capture's evidence completeness; an invocation
     * whose CPU row never lands stays with a `null` cpu_ms and counts
     * against the cell's CPU sample floor. Neither is an execution failure.
     * A harness-level failure — the Worker returning non-2xx, e.g. a 502 for
     * a missing fixture — is not a sample at all: it aborts the run for
     * repair.
     */
    readonly exclusion_policy: "warmup-tagged-before-run-only";
    /** The one confidence level every Lane B/C/D interval and bound is computed at. */
    readonly confidence: 0.95;
    /** Resamples for every bootstrap in this study. Fixed so a report is reproducible from its seed alone. */
    readonly bootstrap_resamples: 2000;
    /** The one bootstrap seed. `statistics.ts` records it on every result; pinning it here makes a report re-derivable. */
    readonly bootstrap_seed: 0;
    /**
     * Telemetry authority and collection policy — evidence-contract v2,
     * preregistered from the 2026-08-24 rehearsal before any production
     * capture.
     *
     * The rehearsal established that `workersInvocationsAdaptive`
     * permanently dropped rows for 2 of 8 measured invocations (distinct
     * minute buckets, absent 20 minutes past the 600 s settle, on a third
     * collection pass) while Workers Observability held every journal
     * `run_id`. Live validation further showed no single Observability
     * event carries both the run-id join line and the platform
     * outcome/cpu/colo summary line — they are two events sharing a platform
     * `requestId` — and that Observability's `cpuTimeMs` is integer
     * milliseconds where the adaptive dataset's `cpuTimeUs` is
     * microsecond-resolution. The preferred single-source design was
     * therefore rejected on evidence and the split below preregistered:
     *
     *  - Workers Observability is the AUTHORITY for invocation existence
     *    and execution outcome (`authority`). Its success literal is `ok`
     *    (`authority_success_outcome`) — NOT the Analytics dataset's
     *    `success`; the collector canonicalizes and retains the verbatim
     *    literal per event.
     *  - `workersInvocationsAdaptive` owns the CPU MEASUREMENT
     *    (`cpu_measurement`, success status literal `cpu_success_status`).
     *    A missing row is CPU-measurement missingness, never an execution
     *    failure, and is gated by `cpu_sample_floor_per_cell`.
     */
    readonly telemetry: {
      readonly authority: "workers-observability";
      /** Workers Observability's verbatim literal for an invocation that completed normally. */
      readonly authority_success_outcome: "ok";
      readonly cpu_measurement: "workers-invocations-adaptive";
      /** The GraphQL Analytics dataset's verbatim success status. */
      readonly cpu_success_status: "success";
      /** Collection-only retries after the initial pass. Re-invoking a run id is never sanctioned. */
      readonly collection_retries: 1;
      /** Fixed delay before the one retry pass. Chosen before production capture. */
      readonly collection_retry_delay_seconds: 600;
    };
  };
}

/** Minimal evidence record shared by this preregistration and later bench work. */
export interface WorkloadCeilingStudyEvidence {
  readonly source: WorkloadCeilingEvidenceSource;
  readonly profile: WorkloadCeilingEvidenceProfile;
  /**
   * The Workers plan billed for the capture. Recorded for provenance; the
   * admission rule deliberately does NOT read it, because the plan does not
   * determine the CPU envelope (see `cpu_envelope`).
   */
  readonly plan: WorkloadCeilingWorkersPlan;
  /**
   * `limits.cpu_ms` in force on the deployed script, or `null` when the
   * script carried no `limits` block and ran under the platform default.
   *
   * `null` is the honest value for an unconfigured deployment on EITHER
   * plan, and it makes such a capture inadmissible as `cf-free` — a
   * credentials filename, a dashboard plan row, and an enforced ceiling are
   * three different things, and only the third one is measurable here.
   */
  readonly configured_cpu_ms: number | null;
  readonly has_zero_failures_upper_bound: boolean;
  /**
   * Every planned measured invocation resolved to exactly one authoritative
   * platform event — no missing, no ambiguous (evidence-contract v2).
   */
  readonly has_complete_evidence: boolean;
  /** Finite successful CPU samples met the preregistered floor in every cell/arm. */
  readonly meets_cpu_sample_floor: boolean;
  readonly statistics: readonly WorkloadCeilingStatistic[];
  readonly has_repeated_tail_drain: boolean;
}

/** The explicit study axes, targets, and admission requirements live here. */
export const WORKLOAD_CEILING_STUDY = {
  id: "baerly.workload-ceiling/chunked-snapshot/v1",
  collection_bytes: [512 * 1024, 1024 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024],
  collection_rows: [2048, 4096, 8192, 16_384],
  document_bytes: [256, 1024, 2048, 5 * 1024],
  changed_byte_fractions: [0.01, 0.1, 1],
  mutation_localities: ["hot-key", "uniform"],
  mutation_mixes: [
    { id: "insert-heavy", insert: 0.8, update: 0.15, delete: 0.05 },
    { id: "update-heavy", insert: 0.05, update: 0.9, delete: 0.05 },
    { id: "delete-heavy", insert: 0.1, update: 0.1, delete: 0.8 },
  ],
  manifest_descriptors: [1, 8, 32],
  read_shapes: ["point", "bounded-range", "index-routed", "complete"],
  read_fan_out_limits: {
    point: 1,
    "bounded-range": 8,
    "index-routed": 32,
    complete: 32,
  },
  axis_sweeps: {
    byte_axis: {
      document_bytes: 2048,
      collection_bytes_measure: "encoded-snapshot-bytes",
    },
    row_axis: {
      document_bytes: 256,
      collection_rows_measure: "rows",
    },
  },
  minimum_useful_targets: {
    byte_axis: {
      collection_bytes: 1024 * 1024,
      document_bytes: 2048,
    },
    row_axis: {
      collection_rows: 4096,
      document_bytes: 256,
    },
  },
  admission: {
    primary_profile: "cf-free",
    requires_deployed_workers: true,
    requires_zero_failures_upper_bound: true,
    requires_complete_evidence: true,
    requires_cpu_sample_floor: true,
    required_statistics: ["p50", "p95", "p99"],
    requires_repeated_tail_drain: true,
    accepted_evidence_sources: ["deployed-workers"],
  },

  cpu_envelope: {
    cf_free_cpu_ms: 10,
    enforcement: "elastic-duty-cycle-dependent",
    obtained_by: "configured-limit",
  },

  /**
   * **Note on account configuration and the `cf-free` evidence profile:**
   *
   * This study measures Worker CPU time during in-memory fold operations.
   * R2 serves the fixture read that precedes the fold and contributes no
   * CPU to the measured quantity, so where the fixtures live never affected
   * `cf-free` validity. What does affect it is whether the 10 ms ceiling is
   * actually in force — and that is a configuration fact, not a plan fact.
   * See `cpu_envelope` for the falsified premise and the replacement rule.
   *
   * The study therefore captures two distinct things on two distinct script
   * versions, and they must not be conflated:
   *
   *  - **The cost curve** (Lanes B/C/D, ~5 h each): CPU-ms against achieved
   *    fixture size, on an UNCONFIGURED script so every cell resolves to a
   *    real number. An `exceededCpu` sample carries a censored `cpu_ms` and
   *    is excluded from the resolved quantiles by
   *    `workload-ceiling-aggregate.ts`, so capturing the curve under a 10 ms
   *    cap would silently delete the upper half of each axis — the half the
   *    `docs/spec/scale-ceilings.md` model is least sure about. This is
   *    `cf-paid` evidence by profile and it is not what admission turns on.
   *  - **The enforcement wall** (the CPU-wall probe, ~45 min): outcome per
   *    cell under `limits.cpu_ms = cpu_envelope.cf_free_cpu_ms`, at two duty
   *    cycles. This is the `cf-free` evidence.
   *
   * The plan cannot be read via API with the study's deploy token (no
   * Billing:Read; `/workers/plans` has no route) — it needs a billing-scoped
   * token or the dashboard. Verification method and findings:
   * `runbooks/lane-b-preflight.md` § Q4. A `-free` credentials filename
   * names a credential set, never a verified plan tier, and a verified plan
   * tier still never implies an enforced ceiling.
   */
  capture: {
    planned_measured_invocations_per_cell: 40,
    cpu_sample_floor_per_cell: 30,
    warmup_invocations_per_cell: 2,
    invocation_spacing_seconds: 70,
    telemetry_settle_seconds: 600,
    exclusion_policy: "warmup-tagged-before-run-only",
    confidence: 0.95,
    bootstrap_resamples: 2000,
    bootstrap_seed: 0,
    telemetry: {
      authority: "workers-observability",
      authority_success_outcome: "ok",
      cpu_measurement: "workers-invocations-adaptive",
      cpu_success_status: "success",
      collection_retries: 1,
      collection_retry_delay_seconds: 600,
    },
  },
} as const satisfies WorkloadCeilingStudyContract;

/**
 * The study's deliberately small admission predicate. It evaluates only
 * preregistered evidence fields; provision, collection, and telemetry details
 * remain the concern of the later measurement harness. The `admission`
 * `requires_*` flags are the declarative record of these requirements — each
 * is pinned to `true` by the contract type, so the predicate asserts the
 * requirements directly rather than guarding on flags that can never flip.
 */
export const satisfiesWorkloadCeilingAdmission = (
  evidence: WorkloadCeilingStudyEvidence,
): boolean => {
  const admission = WORKLOAD_CEILING_STUDY.admission;
  const acceptedSources: readonly WorkloadCeilingEvidenceSource[] =
    admission.accepted_evidence_sources;

  return (
    acceptedSources.includes(evidence.source) &&
    evidence.profile === admission.primary_profile &&
    // The `cf-free` envelope must be CONFIGURED, not inherited from a plan.
    // A Workers Free account does not enforce its own 10 ms limit reliably
    // (WORKLOAD_CEILING_STUDY.cpu_envelope), so `plan` is provenance only
    // and this is the check that decides.
    evidence.configured_cpu_ms === WORKLOAD_CEILING_STUDY.cpu_envelope.cf_free_cpu_ms &&
    evidence.has_zero_failures_upper_bound &&
    // Evidence-contract v2: admission independently requires complete
    // evidence and the CPU sample floor. A missing or ambiguous
    // authoritative record blocks admission without being an execution
    // failure; a short CPU sample blocks admission without being one either.
    evidence.has_complete_evidence &&
    evidence.meets_cpu_sample_floor &&
    admission.required_statistics.every((statistic) => evidence.statistics.includes(statistic)) &&
    evidence.has_repeated_tail_drain
  );
};
