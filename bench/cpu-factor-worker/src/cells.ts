// The cell catalogue shared by the build, the Worker, the request driver,
// the Node baseline and the analyzer. One request runs one cell:
// GET /?cell=<name>. Pure data, no runtime globals, so Node and workerd
// both import it.

export type CellKind = "noop" | "subject" | "fold" | "tree" | "probe";
export type ProbeKind = "r2-head" | "fetch" | "cache-match";

export interface FixtureSpec {
  readonly rows: number;
  readonly payload: number;
  /** Informational: the fixture's intended snapshot size in KiB. */
  readonly kib?: number;
}

export interface TreeParams {
  /** Leaves re-encoded and hashed in one step. */
  readonly k: number;
  /** Approximate JSON bytes per leaf, in KiB. */
  readonly bKiB: number;
  /** Path nodes (internal levels) re-encoded and hashed above the leaves. */
  readonly d: number;
}

export interface Cell {
  readonly name: string;
  readonly kind: CellKind;
  readonly fixture?: string;
  readonly part?: "all" | "write" | "fold" | "load";
  readonly entries?: number;
  /** Gate cell: "C" (bytes) or "E" (rows) for the compactor-11 style verdict. */
  readonly gate?: "C" | "E";
  /** Position on the bytes ladder (KiB of snapshot). */
  readonly ladder?: number;
  /** Position on the rows ladder. */
  readonly rowsLadder?: number;
  readonly mutations?: number;
  readonly tree?: TreeParams;
  readonly probe?: ProbeKind;
  /** Requests the driver sends for this cell; defaults to the driver's N. */
  readonly samples?: number;
}

/** Fixtures for the fold cells. C = 512 KiB of 2 KiB docs; E = 2,028 rows (the largest foldable under E = 2,048). */
export const FIXTURES: Readonly<Record<string, FixtureSpec>> = {
  r256: { rows: 256, payload: 200 },
  r512: { rows: 512, payload: 200 },
  r1024: { rows: 1024, payload: 200 },
  b4: { rows: 2, payload: 2000, kib: 4 },
  b16: { rows: 8, payload: 2000, kib: 16 },
  b64: { rows: 31, payload: 2000, kib: 64 },
  b128: { rows: 63, payload: 2000, kib: 128 },
  b256: { rows: 125, payload: 2000, kib: 256 },
  C: { rows: 245, payload: 2000, kib: 512 },
  E: { rows: 2028, payload: 200, kib: 512 },
};

/** The original factor subject's fixtures (rows of 2 KiB docs). */
export const SUBJECT_FIXTURES: Readonly<Record<string, FixtureSpec>> = {
  "subject-0.5MiB": { rows: 256, payload: 2000 },
  "subject-1MiB": { rows: 512, payload: 2000 },
};

/** Tree fold-step grid: leaves per step x leaf size x path depth. */
export const TREE_K = [1, 2, 4, 8] as const;
export const TREE_B_KIB = [4, 16, 64] as const;
export const TREE_D = [1, 2, 3] as const;

/** Sequential calls per S1 probe; the Free subrequest cap (50) sits inside. */
export const PROBE_CALLS = 60;
/** Requests per probe cell: each request is an independent invocation. */
export const PROBE_SAMPLES = 5;

export const treeCellName = (t: TreeParams): string => `tree-k${t.k}-b${t.bKiB}-d${t.d}`;

const foldCells = (): Cell[] => [
  {
    name: "main-C-all-e16",
    kind: "fold",
    fixture: "C",
    part: "all",
    entries: 16,
    gate: "C",
    ladder: 512,
  },
  { name: "main-C-all-e4", kind: "fold", fixture: "C", part: "all", entries: 4 },
  { name: "main-C-all-e1", kind: "fold", fixture: "C", part: "all", entries: 1 },
  { name: "main-C-write", kind: "fold", fixture: "C", part: "write", entries: 0 },
  { name: "main-C-load", kind: "fold", fixture: "C", part: "load", entries: 0 },
  {
    name: "main-E-all-e16",
    kind: "fold",
    fixture: "E",
    part: "all",
    entries: 16,
    gate: "E",
    rowsLadder: 2028,
  },
  { name: "main-E-all-e1", kind: "fold", fixture: "E", part: "all", entries: 1 },
  { name: "main-E-load", kind: "fold", fixture: "E", part: "load", entries: 0 },
  { name: "main-b4-all-e1", kind: "fold", fixture: "b4", part: "all", entries: 1 },
  { name: "main-b16-all-e1", kind: "fold", fixture: "b16", part: "all", entries: 1 },
  { name: "main-b16-all-e16", kind: "fold", fixture: "b16", part: "all", entries: 16, ladder: 16 },
  { name: "main-b64-all-e16", kind: "fold", fixture: "b64", part: "all", entries: 16, ladder: 64 },
  {
    name: "main-b128-all-e16",
    kind: "fold",
    fixture: "b128",
    part: "all",
    entries: 16,
    ladder: 128,
  },
  {
    name: "main-b256-all-e16",
    kind: "fold",
    fixture: "b256",
    part: "all",
    entries: 16,
    ladder: 256,
  },
  {
    name: "main-r256-all-e16",
    kind: "fold",
    fixture: "r256",
    part: "all",
    entries: 16,
    rowsLadder: 256,
  },
  {
    name: "main-r512-all-e16",
    kind: "fold",
    fixture: "r512",
    part: "all",
    entries: 16,
    rowsLadder: 512,
  },
  {
    name: "main-r1024-all-e16",
    kind: "fold",
    fixture: "r1024",
    part: "all",
    entries: 16,
    rowsLadder: 1024,
  },
];

const treeCells = (): Cell[] =>
  TREE_B_KIB.flatMap((bKiB) =>
    TREE_D.flatMap((d) =>
      TREE_K.map((k): Cell => {
        const tree = { k, bKiB, d };
        return { name: treeCellName(tree), kind: "tree", tree };
      }),
    ),
  );

const probeCells = (): Cell[] =>
  (["r2-head", "fetch", "cache-match"] as const).map((probe): Cell => ({
    name: `probe-${probe}`,
    kind: "probe",
    probe,
    samples: PROBE_SAMPLES,
  }));

export const CELLS: readonly Cell[] = [
  { name: "noop", kind: "noop" },
  { name: "subject-0.5MiB-m20", kind: "subject", fixture: "subject-0.5MiB", mutations: 20 },
  { name: "subject-0.5MiB-m5", kind: "subject", fixture: "subject-0.5MiB", mutations: 5 },
  { name: "subject-1MiB-m20", kind: "subject", fixture: "subject-1MiB", mutations: 20 },
  ...foldCells(),
  ...treeCells(),
  ...probeCells(),
];

export const CELL_BY_NAME: Readonly<Record<string, Cell>> = Object.fromEntries(
  CELLS.map((c) => [c.name, c]),
);
