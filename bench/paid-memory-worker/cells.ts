/**
 * Cell grid for the deployed memory bench. One cell is one collection in
 * its own tenant, so cells never share a log or a snapshot.
 *
 * - `rw` cells serve the point-read and single-update arms. Their
 *   `current.json` carries no `mean_entry_bytes`, so the write tick never
 *   folds them (the derived tail estimate stays far below the snapshot).
 * - `fold` cells are the same snapshot and tail with `mean_entry_bytes`
 *   raised so that the next write's derived tail reaches the snapshot size
 *   and its in-band tick folds (FORCED trigger). That field feeds only the
 *   trigger estimate; the fold itself reads, applies and rewrites the real
 *   bytes. The row count is chosen so the folding write does not cross the
 *   hard-GC boundary, which would run GC instead of the fold.
 * - The `natural` cell carries the tail main's own ratio trigger produces
 *   just below its fold point: about one snapshot's worth of entries, with
 *   the `mean_entry_bytes` a real fold would have stamped.
 */
import { GC_STARVATION_GUARD, NODE_MAINTENANCE_GC_INTERVAL } from "@baerly/protocol";

export const APP = "pm";
export const COLLECTION = "notes";
/** Live tail on `rw` / `fold` cells; at least the write tick's 50-entry fold floor. */
export const FIXTURE_TAIL = 100;
/** Entries the natural cell sits below its ratio trip point. */
export const NATURAL_HEADROOM = 10;
/** The `cf-paid` profile's hard-GC cadence: commits per guaranteed GC tick. */
export const HARD_GC_INTERVAL = NODE_MAINTENANCE_GC_INTERVAL * GC_STARVATION_GUARD;

export type CellKind = "rw" | "fold" | "natural";

export interface CellSpec {
  /** Also the tenant segment of every key. */
  readonly tenant: string;
  readonly kind: CellKind;
  readonly targetMiB: number;
  readonly bytesPerDoc: number;
}

const MIB = [8, 16, 24, 32, 40, 48] as const;

export const CELLS: readonly CellSpec[] = [
  ...MIB.flatMap((m): CellSpec[] => [
    { tenant: `s${m}k5`, kind: "rw", targetMiB: m, bytesPerDoc: 5120 },
    { tenant: `s${m}k5f`, kind: "fold", targetMiB: m, bytesPerDoc: 5120 },
  ]),
  { tenant: "s32k1", kind: "rw", targetMiB: 32, bytesPerDoc: 1024 },
  { tenant: "s32k1f", kind: "fold", targetMiB: 32, bytesPerDoc: 1024 },
  { tenant: "s32k5n", kind: "natural", targetMiB: 32, bytesPerDoc: 5120 },
];

export const tenantPrefix = (tenant: string): string => `app/${APP}/tenant/${tenant}/`;
export const currentJsonKey = (tenant: string): string =>
  `${tenantPrefix(tenant)}manifests/${COLLECTION}/current.json`;

/** What `fixtures.ts` writes per cell and `drive.ts` uploads and drives. */
export interface CellManifest {
  readonly tenant: string;
  readonly kind: CellKind;
  readonly bytesPerDoc: number;
  readonly rows: number;
  readonly snapshotBytes: number;
  readonly snapshotKey: string;
  /** Snapshot file under `out/fixtures/`, uploaded as one object. */
  readonly snapshotFile: string;
  /** Tenant whose identical snapshot bytes the Worker copies instead of a re-upload. */
  readonly snapshotCopyFrom?: string;
  /** `current.json` plus every live log entry, `{ key: utf8 text }`. */
  readonly smallFile: string;
  readonly smallObjects: number;
  readonly logSeqStart: number;
  readonly tailEntries: number;
  readonly meanEntryBytes?: number;
  /** Row every read and update arm targets. */
  readonly docId: string;
}
