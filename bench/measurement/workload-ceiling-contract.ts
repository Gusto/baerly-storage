export type WorkloadCeilingReadShape = "point" | "bounded-range" | "index-routed" | "complete";

export type WorkloadCeilingEvidenceSource = "deployed-workers" | "node" | "miniflare";

export type WorkloadCeilingEvidenceProfile = "cf-free" | "cf-paid" | "node";

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
    readonly required_statistics: readonly ["p50", "p95", "p99"];
    readonly requires_repeated_tail_drain: true;
    readonly accepted_evidence_sources: readonly ["deployed-workers"];
  };
}

/** Minimal evidence record shared by this preregistration and later bench work. */
export interface WorkloadCeilingStudyEvidence {
  readonly source: WorkloadCeilingEvidenceSource;
  readonly profile: WorkloadCeilingEvidenceProfile;
  readonly has_zero_failures_upper_bound: boolean;
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
    required_statistics: ["p50", "p95", "p99"],
    requires_repeated_tail_drain: true,
    accepted_evidence_sources: ["deployed-workers"],
  },
} as const satisfies WorkloadCeilingStudyContract;

/**
 * The study's deliberately small admission predicate. It evaluates only
 * preregistered evidence fields; provision, collection, and telemetry details
 * remain the concern of the later measurement harness.
 */
export const satisfiesWorkloadCeilingAdmission = (
  evidence: WorkloadCeilingStudyEvidence,
): boolean => {
  const admission = WORKLOAD_CEILING_STUDY.admission;
  const acceptedSources: readonly WorkloadCeilingEvidenceSource[] =
    admission.accepted_evidence_sources;

  return (
    (!admission.requires_deployed_workers || acceptedSources.includes(evidence.source)) &&
    evidence.profile === admission.primary_profile &&
    (!admission.requires_zero_failures_upper_bound || evidence.has_zero_failures_upper_bound) &&
    admission.required_statistics.every((statistic) => evidence.statistics.includes(statistic)) &&
    (!admission.requires_repeated_tail_drain || evidence.has_repeated_tail_drain)
  );
};
