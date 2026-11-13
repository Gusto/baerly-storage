// Seeds a SYNTHETIC corpus into a bucket using an OLD published
// `@gusto/baerly-storage` install, through that version's own public API.
// Spawned by `old-binary-harness.mjs`; not meant to be run by hand.
//
//   node seed-corpus.mjs --pkg <install-dir> --root <abs-dir> --out <expected.json>
//        [--seed N] [--rows N] [--tail-writes N]
//
// `--pkg` is the scratch dir holding `node_modules/@gusto/baerly-storage`.
// Modules are imported by absolute path so this file can live in the repo.
// Everything written is generated from the seed: no real data.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { values: args } = parseArgs({
  options: {
    pkg: { type: "string" },
    root: { type: "string" },
    out: { type: "string" },
    seed: { type: "string", default: "1" },
    rows: { type: "string", default: "48" },
    "tail-writes": { type: "string", default: "130" },
  },
});
for (const k of ["pkg", "root", "out"]) {
  if (!args[k]) {
    throw new Error(`missing --${k}`);
  }
}

const dist = join(args.pkg, "node_modules/@gusto/baerly-storage/dist");
const load = (f) => import(pathToFileURL(join(dist, f)).href);
const { Db, defineConfig } = await load("index.js");
const { LocalFsStorage } = await load("dev.js");
const { compact, runGc } = await load("maintenance.js");
const version = JSON.parse(
  readFileSync(join(args.pkg, "node_modules/@gusto/baerly-storage/package.json"), "utf8"),
).version;

const APP = "migproof";
const TENANT = "t1";
const TICKETS = "tickets";
const NOTES = "notes";

// mulberry32: deterministic across Node versions.
let state = Number(args.seed) >>> 0;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const STATUSES = ["open", "closed", "pending", "blocked"];
const OWNERS = ["ana", "bo", "cy", "dee"];

// Hand-picked IDs. The non-NFC ones predate the 0.7 NFC rule and are the
// "legacy copy" cases. None has an NFC/NFD twin, because default macOS APFS
// folds canonically equivalent file names onto one path.
const SPECIAL_IDS = [
  "café", // NFC
  "日本語-1", // CJK
  "emoji-\u{1f600}", // astral plane
  "ｆｕｌｌ", // fullwidth, NFC-stable (NFKC would change it)
  "nfd-café", // LEGACY: NFD, `e` + U+0301
  "Å-angstrom", // LEGACY: U+212B ANGSTROM SIGN, NFC form is U+00C5
];
// 0.6.0 rejects "/" in an _id, and 0.1.0 accepts it but drops such rows from
// index-routed reads, so "/" is kept out of the corpus. Spaces are fine.
const NOTE_SPECIAL_IDS = ["sp ace", "two  spaces"];
const LEGACY_NON_NFC = SPECIAL_IDS.filter((id) => id !== id.normalize("NFC"));
if (LEGACY_NON_NFC.length < 2) {
  throw new Error("corpus must contain non-NFC ids");
}

const config = defineConfig({
  app: APP,
  tenant: TENANT,
  collections: {
    [TICKETS]: {
      indexes: [
        { name: "by_status", on: "status" },
        { name: "by_owner_status", on: ["owner", "status"] },
      ],
    },
    [NOTES]: {},
  },
});
const storage = new LocalFsStorage({ root: args.root });
const db = Db.create({ storage, app: APP, tenant: TENANT, config });
const tickets = db.collection(TICKETS);
const notes = db.collection(NOTES);
const currentJsonKey = (c) => `app/${APP}/tenant/${TENANT}/manifests/${c}/current.json`;

// Model of what each collection must contain: Map<id, row>.
const model = { [TICKETS]: new Map(), [NOTES]: new Map() };
const clone = (v) => JSON.parse(JSON.stringify(v));

// JSON merge patch (RFC 7386) applied to the model.
const mergePatch = (target, patch) => {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return clone(patch);
  }
  const out = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
    } else {
      out[k] = mergePatch(out[k], v);
    }
  }
  return out;
};

const newRow = (id, n) => ({
  _id: id,
  title: `ticket ${n} — café 日本`,
  status: pick(STATUSES),
  owner: pick(OWNERS),
  priority: Math.floor(rand() * 5),
  meta: {
    labels: [pick(["a", "b", "c"]), "x"],
    dims: { w: n, h: n * 2 },
    deep: { a: { b: { c: n } } },
  },
  note: n % 4 === 0 ? null : `note ${n}`, // legacy null field on a quarter of rows
});

const insertTicket = async (row) => {
  await tickets.insert(clone(row));
  model[TICKETS].set(row._id, clone(row));
};
const updateTicket = async (id, patch) => {
  await tickets.update(id, patch);
  model[TICKETS].set(id, mergePatch(model[TICKETS].get(id), patch));
};
const deleteTicket = async (id) => {
  await tickets.delete(id);
  model[TICKETS].delete(id);
};
const log = (m) => console.log(`[seed ${version}] ${m}`);

// Phase 1: initial rows (special ids first), then updates and deletes.
const rowCount = Number(args.rows);
const ids = [...SPECIAL_IDS];
for (let i = SPECIAL_IDS.length; i < rowCount; i++) {
  ids.push(`t-${String(i).padStart(4, "0")}`);
}
for (const [i, id] of ids.entries()) {
  await insertTicket(newRow(id, i));
}
for (const id of ids.filter((_, i) => i % 3 === 0)) {
  await updateTicket(id, { status: pick(STATUSES), meta: { dims: { w: 99 } }, note: null });
}
for (const id of ids.filter((_, i) => i % 7 === 3)) {
  await deleteTicket(id);
}
for (let i = 0; i < 6 + NOTE_SPECIAL_IDS.length; i++) {
  const row = {
    _id: NOTE_SPECIAL_IDS[i - 6] ?? `n-${i}`,
    body: `note body ${i}`,
    tags: ["x", `y${i}`],
    extra: null,
  };
  await notes.insert(clone(row));
  model[NOTES].set(row._id, clone(row));
}
const live = () => [...model[TICKETS].keys()];

// Phase 2: fold into a snapshot, write more, fold again (second snapshot
// makes the first an orphan), then GC to leave candidate marks.
const maint = {};
maint.fold1 = await compact(
  { storage, currentJsonKey: currentJsonKey(TICKETS) },
  { minEntriesToCompact: 1 },
);
for (let i = 0; i < 20; i++) {
  const id = pick(live().filter((x) => !LEGACY_NON_NFC.includes(x)));
  await updateTicket(id, { priority: Math.floor(rand() * 5), status: pick(STATUSES) });
}
maint.fold2 = await compact(
  { storage, currentJsonKey: currentJsonKey(TICKETS) },
  { minEntriesToCompact: 1 },
);
maint.gc = await runGc({ storage, currentJsonKey: currentJsonKey(TICKETS) });
maint.noteFold = await compact(
  { storage, currentJsonKey: currentJsonKey(NOTES) },
  { minEntriesToCompact: 1 },
);

// Phase 3: a long live tail after the last fold (not compacted).
const tailWrites = Number(args["tail-writes"]);
for (let i = 0; i < tailWrites; i++) {
  const r = rand();
  const candidates = live();
  if (r < 0.35) {
    await insertTicket(newRow(`tail-${String(i).padStart(4, "0")}`, 1000 + i));
  } else if (r < 0.85 && candidates.length > 0) {
    await updateTicket(pick(candidates), {
      status: pick(STATUSES),
      owner: pick(OWNERS),
      note: i % 5 === 0 ? null : `tail ${i}`,
    });
  } else if (candidates.length > LEGACY_NON_NFC.length + 5) {
    const id = pick(candidates.filter((x) => !LEGACY_NON_NFC.includes(x)));
    await deleteTicket(id);
  }
}
// Keep one legacy id with an index-visible update inside the tail.
await updateTicket(LEGACY_NON_NFC[0], { status: "blocked", owner: "ana" });

// Verify the version reads back exactly what the model says, via point reads,
// full scans and index-routed queries. A failure here is a harness bug.
const cmp = (a, b) => {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
};
const sortById = (a, b) => cmp(a._id, b._id);
const sortKeys = (x) => {
  if (Array.isArray(x)) {
    return x.map(sortKeys);
  }
  if (x && typeof x === "object") {
    return Object.fromEntries(
      Object.entries(x)
        .toSorted(([k1], [k2]) => cmp(k1, k2))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return x;
};
const canon = (v) => JSON.stringify(sortKeys(v));
const expectedRows = (c) => [...model[c].values()].toSorted(sortById);
const check = (what, got, want) => {
  if (canon(got) !== canon(want)) {
    throw new Error(
      `self-check failed: ${what}\n got ${canon(got).slice(0, 400)}\nwant ${canon(want).slice(0, 400)}`,
    );
  }
};
const idsOf = (rows) => rows.map((r) => r._id).toSorted(cmp);
for (const [name, col] of [
  [TICKETS, tickets],
  [NOTES, notes],
]) {
  const all = await col.all();
  check(`${name} full scan`, all.toSorted(sortById), expectedRows(name));
}
for (const id of LEGACY_NON_NFC) {
  check(`point read ${JSON.stringify(id)}`, await tickets.get(id), model[TICKETS].get(id));
}
const queries = {};
for (const status of STATUSES) {
  const want = idsOf(expectedRows(TICKETS).filter((r) => r.status === status));
  const hit = await tickets.where({ status }).all();
  check(`where status=${status}`, idsOf(hit), want);
  queries[`status=${status}`] = want;
}
for (const owner of OWNERS) {
  for (const status of STATUSES) {
    const want = idsOf(
      expectedRows(TICKETS).filter((r) => r.owner === owner && r.status === status),
    );
    const hit = await tickets.where({ owner, status }).all();
    check(`where owner=${owner},status=${status}`, idsOf(hit), want);
    queries[`owner=${owner},status=${status}`] = want;
  }
}

const summarise = (r) =>
  JSON.parse(JSON.stringify(r ?? null, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
writeFileSync(
  args.out,
  JSON.stringify(
    {
      version,
      app: APP,
      tenant: TENANT,
      collections: [TICKETS, NOTES],
      indexes: { [TICKETS]: ["by_status", "by_owner_status"] },
      legacyNonNfcIds: LEGACY_NON_NFC,
      specialIds: SPECIAL_IDS,
      rows: { [TICKETS]: expectedRows(TICKETS), [NOTES]: expectedRows(NOTES) },
      queries,
      maintenance: summarise(maint),
      tailWrites,
    },
    null,
    2,
  ) + "\n",
);
log(`seeded ${model[TICKETS].size} tickets, ${model[NOTES].size} notes; wrote ${args.out}`);
