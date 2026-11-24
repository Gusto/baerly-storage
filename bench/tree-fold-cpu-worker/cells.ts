/**
 * Fixture and cell grid of the tree fold CPU bench. Pure: imported by the
 * Node fixture builder, the Node baseline, the driver, the analyzer and the
 * Worker.
 *
 * A fixture is one tenant holding one tree collection: the canonical tree of
 * `rows` documents of `docBytes` bytes at the production layout, plus an
 * unfolded log tail of {@link TAIL_ENTRIES} scattered changes. The trees
 * match the depths the Workers Paid fold ceilings reach (the same shapes as
 * the tree op-model's cross-check): depth 0 at the single-leaf rule's
 * 512 KiB, depth 1 at 1 MiB, depth 2 at Paid's 8 MiB / 32,768 rows.
 *
 * A cell is one fold tick on one fixture under a fresh Paid request ledger
 * ({@link LEDGER_CALLS} calls), with the log cut at `cap` entries (the fold
 * reaches the tail) or left whole (`cap: null`: the ledger ends the fold),
 * over R2 or over in-isolate memory.
 */
import { CF_PAID_REQUEST_LIMIT } from "@baerly/protocol";

export const APP = "tf";
export const COLLECTION = "notes";

/** The request ledger every tick starts with: Workers Paid's. */
export const LEDGER_CALLS: number = CF_PAID_REQUEST_LIMIT;

/**
 * Unfolded log entries in every fixture. A tick charges each GET at every
 * retry attempt (3), so a 9,000-call ledger reads under 3,000 entries; 3,200
 * keeps every whole-log cell ledger-bound.
 */
export const TAIL_ENTRIES = 3200;

/** The attempt identity of every fixture node. A fold mints random ones. */
export const FIXTURE_ATTEMPT = `${"0".repeat(31)}1`;

export interface FixtureSpec {
  readonly tenant: string;
  readonly docBytes: number;
  readonly rows: number;
  /** The root level the build must produce. */
  readonly depth: number;
}

export const FIXTURES: readonly FixtureSpec[] = [
  { tenant: "d0b256", docBytes: 256, rows: 2048, depth: 0 },
  { tenant: "d1b256", docBytes: 256, rows: 4096, depth: 1 },
  { tenant: "d2b256", docBytes: 256, rows: 32_768, depth: 2 },
  { tenant: "d0k5", docBytes: 5120, rows: 102, depth: 0 },
  { tenant: "d1k5", docBytes: 5120, rows: 204, depth: 1 },
  { tenant: "d2k5", docBytes: 5120, rows: 1638, depth: 2 },
];

/** Entry caps; `null` leaves the whole tail, so the ledger ends the fold. */
export const CAPS: readonly (number | null)[] = [100, 500, 1000, null];

export type StorageKind = "r2" | "memory";
export const STORAGES: readonly StorageKind[] = ["r2", "memory"];

export interface Cell {
  readonly name: string;
  readonly fixture: FixtureSpec;
  readonly cap: number | null;
  readonly storage: StorageKind;
}

const cellName = (tenant: string, cap: number | null, storage: StorageKind): string =>
  `${tenant}-${cap ?? "ledger"}-${storage}`;

/** Every cell, fixture by fixture, caps ascending, R2 before memory. */
export const CELLS: readonly Cell[] = FIXTURES.flatMap((fixture) =>
  CAPS.flatMap((cap) =>
    STORAGES.map((storage) => ({
      name: cellName(fixture.tenant, cap, storage),
      fixture,
      cap,
      storage,
    })),
  ),
);

const BY_NAME = new Map(CELLS.map((c) => [c.name, c]));

/** The cell named `name`, or `undefined`. */
export const cellByName = (name: string): Cell | undefined => BY_NAME.get(name);

/**
 * Cells matching `patterns`: a full cell name, or a prefix such as a tenant
 * (`d1k5`) or tenant and cap (`d1k5-ledger`), or a `*` for every cell.
 *
 * @throws Error — a pattern matches no cell.
 */
export const selectCells = (patterns: readonly string[]): Cell[] => {
  if (patterns.length === 0 || patterns.includes("*")) {
    return [...CELLS];
  }
  const picked = new Set<Cell>();
  for (const p of patterns) {
    const hits = CELLS.filter((c) => c.name === p || c.name.startsWith(`${p}-`));
    if (hits.length === 0) {
      throw new Error(`no cell matches ${JSON.stringify(p)}`);
    }
    for (const c of hits) {
      picked.add(c);
    }
  }
  return CELLS.filter((c) => picked.has(c));
};

export const fixtureByTenant = (tenant: string): FixtureSpec | undefined =>
  FIXTURES.find((f) => f.tenant === tenant);

/** Every key of `tenant` starts with this. */
export const tenantRoot = (tenant: string): string => `app/${APP}/tenant/${tenant}/`;

/** The collection prefix `P` of `tenant`. */
export const collectionPrefix = (tenant: string): string =>
  `${tenantRoot(tenant)}manifests/${COLLECTION}`;

export const headKey = (tenant: string): string => `${collectionPrefix(tenant)}/current.json`;

/** A copy of the fixture head, outside the collection, that a reset restores. */
export const savedHeadKey = (tenant: string): string => `${tenantRoot(tenant)}bench/head.json`;

/** What the fixture builder records per tenant (`out/manifest.json`). */
export interface FixtureManifest {
  readonly tenant: string;
  readonly docBytes: number;
  readonly rows: number;
  readonly depth: number;
  /** Canonical document bytes of the tree. */
  readonly treeBytes: number;
  /** Nodes per level, leaves first. */
  readonly levelNodes: readonly number[];
  readonly nodes: number;
  readonly tailEntries: number;
  /** Objects in the fixture file: nodes, log entries and the head. */
  readonly objects: number;
  /** UTF-8 bytes of every object. */
  readonly bytes: number;
  /** The fixture file, relative to `out/fixtures/`. */
  readonly file: string;
  /** SHA-256 of the fixture file. */
  readonly sha256: string;
}
