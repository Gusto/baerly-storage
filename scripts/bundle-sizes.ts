/** A measured size axis. */
export type Axis = "raw" | "gz" | "minGz";

/** Growth allowance and gated axes for a class of entry. */
export interface TierPolicy {
  /** Fractional growth allowed before the gate trips, e.g. 0.02 for 2%. */
  pct: number;
  /** Which axes this tier gates. */
  axes: readonly Axis[];
}

export interface SnapshotPolicy {
  /**
   * Absolute floor on the delta allowance. Binds only where `pct * baseline`
   * falls below it — on the min-gz axis of the smallest entries. Build output
   * is bit-for-bit deterministic (verified across three builds), so this
   * absorbs no noise; it exists purely to keep a 2 KB entry off a 45-byte
   * hair trigger.
   */
  floorBytes: number;
  tiers: Record<string, TierPolicy>;
}

export interface SnapshotEntry {
  /** Key into `SnapshotPolicy.tiers`. */
  tier: string;
  raw?: number;
  gz?: number;
  minGz?: number;
  /**
   * Absolute limits. Unlike the delta gate these cannot be regenerated away:
   * `--write` refuses to cross one, so raising it is a deliberate hand edit.
   *
   * Reserved for a bound that encodes a STRUCTURAL FACT rather than a
   * measurement — see `app-config.js`, whose ceiling asserts the entry has no
   * runtime closure at all. A ceiling parked a round number above whatever an
   * entry happens to weigh today encodes nothing: it cannot be derived, cannot
   * be defended in review, and drifts with the measurement it was copied from.
   * Use the delta gate for creep, and a structural test for the composition
   * facts bytes cannot express.
   */
  hardCeiling?: Partial<Record<Axis, number>>;
  /** Why this entry is classified the way it is. Preserved across `--write`. */
  note: string;
}

export interface Snapshot {
  $comment?: string;
  policy: SnapshotPolicy;
  entries: Record<string, SnapshotEntry>;
}

/** A fresh measurement of one entry's closure. */
export interface Measured {
  raw: number;
  gz: number;
  minGz?: number;
}

export type Violation =
  | {
      kind: "delta";
      entry: string;
      axis: Axis;
      baseline: number;
      measured: number;
      limit: number;
    }
  | { kind: "ceiling"; entry: string; axis: Axis; ceiling: number; measured: number };

/** Bytes of growth allowed before the delta gate trips. */
export function deltaLimit(baseline: number, pct: number, floorBytes: number): number {
  return Math.max(baseline * pct, floorBytes);
}

/**
 * A ceiling violation is structural: it cannot be regenerated away, because
 * the number it crossed is a deliberate commitment rather than a measurement.
 * Mirrors the `--write`-blocking structural checks in check-version-matrix.ts.
 */
export function blocksWrite(v: Violation): boolean {
  return v.kind === "ceiling";
}

/**
 * Compare a fresh measurement against the committed snapshot.
 *
 * Reports EVERY violation rather than stopping at the first, so one over-budget
 * axis cannot mask another and force a second round trip.
 */
export function compareSnapshot(
  snapshot: Snapshot,
  measured: Record<string, Measured>,
): Violation[] {
  const violations: Violation[] = [];
  for (const [entry, spec] of Object.entries(snapshot.entries)) {
    const tier = snapshot.policy.tiers[spec.tier];
    if (!tier) {
      throw new Error(
        `bundle-sizes: entry "${entry}" declares unknown tier "${spec.tier}" (known: ${Object.keys(
          snapshot.policy.tiers,
        ).join(", ")})`,
      );
    }
    const now = measured[entry];
    if (!now) {
      throw new Error(
        `bundle-sizes: snapshot lists "${entry}" but it was not measured — was it removed from the build?`,
      );
    }
    for (const axis of tier.axes) {
      const baseline = spec[axis];
      const current = now[axis];
      if (baseline === undefined || current === undefined) {
        continue;
      }
      const limit = deltaLimit(baseline, tier.pct, snapshot.policy.floorBytes);
      if (current - baseline > limit) {
        violations.push({ kind: "delta", entry, axis, baseline, measured: current, limit });
      }
    }
    for (const [axis, ceiling] of Object.entries(spec.hardCeiling ?? {})) {
      const current = now[axis as Axis];
      if (current !== undefined && ceiling !== undefined && current > ceiling) {
        violations.push({
          kind: "ceiling",
          entry,
          axis: axis as Axis,
          ceiling,
          measured: current,
        });
      }
    }
  }
  return violations;
}
