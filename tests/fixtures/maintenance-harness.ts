/**
 * Shared scaffolding for the two maintenance end-to-end suites:
 * `tests/integration/phase5-end-to-end.test.ts` and
 * `tests/integration/maintenance-profile-equivalence.test.ts`.
 *
 * Both seed a single-collection bucket, bootstrap an identical
 * `current.json`, and run their op streams across the same
 * `memory` + `local-fs` variant matrix. Only the genuinely-common
 * boilerplate lives here — each suite keeps its own op streams,
 * assertions, and profile cases. The shape that MUST stay in lockstep
 * across both suites (one `current.json` bootstrap, one variant matrix)
 * has exactly one definition here.
 *
 * NOT a `.test.ts` file — it's a fixture, so vitest never picks it up
 * as a suite (see `docs/contributing/conventions/tests.md`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type DocumentData,
  MemoryStorage,
  type Storage,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";

export const APP = "app";
export const TENANT = "tenant";
export const COLLECTION = "tickets";
export const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLLECTION}`;
export const CURRENT_JSON_KEY = `${TABLE_PREFIX}/current.json`;

/**
 * The document shape both suites seed. `phase5-end-to-end` uses the
 * three required fields directly; `maintenance-profile-equivalence`
 * carries an extra `rev` on its own row type — its op stream needs the
 * revision counter, this gate's doesn't. Kept to the common core here
 * so neither suite over-constrains the other.
 */
export interface Ticket extends DocumentData {
  _id: string;
  status: "open" | "closed";
  priority: number;
}

/**
 * Write the canonical empty `current.json` both suites start from. The
 * `owner` tag is the one field that differs between callers (it names
 * the suite for forensic readability of the fence record), so it's a
 * parameter — everything else is byte-identical.
 */
export const bootstrap = async (storage: Storage, owner: string): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner, claimed_at: "" },
    tail_bytes: 0,
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

/** Stable sort by `_id` so cross-profile / pre-vs-post deep-equals are order-insensitive. */
export const sortById = <T extends { _id: string }>(rows: readonly T[]): T[] =>
  [...rows].toSorted((a, b) => {
    if (a._id < b._id) {
      return -1;
    }
    if (a._id > b._id) {
      return 1;
    }
    return 0;
  });

export interface Variant {
  readonly label: "memory" | "local-fs";
  readonly build: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
}

/**
 * The `memory` + `local-fs` variant matrix both suites run. The only
 * per-suite difference is the tmpdir prefix the `local-fs` arm passes to
 * `mkdtemp`, so it's a parameter — each suite keeps its own tmp namespace
 * without sharing a directory name.
 */
export const makeVariants = (tmpPrefix: string): readonly Variant[] => [
  {
    label: "memory",
    build: async () => ({ storage: new MemoryStorage() }),
  },
  {
    label: "local-fs",
    build: async () => {
      const root = await mkdtemp(join(tmpdir(), tmpPrefix));
      return {
        storage: new LocalFsStorage({ root }),
        cleanup: async () => {
          await rm(root, { recursive: true, force: true }).catch(() => {
            // Stale tmp dir under a crashed worker shouldn't fail the
            // suite; the OS reaps `/tmp` eventually.
          });
        },
      };
    },
  },
];
