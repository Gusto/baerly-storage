/**
 * `GET /v1/since` request costs on Workers Free, under the request
 * ledger's Free limits: storage over `fetch` (S3 over HTTP) charges the
 * 45-call `external` pool, the R2 binding the 900-call `internal` pool.
 *
 * A `since-idle-no-timeout` cell is one long-poll that finds nothing,
 * run with a deadline no budget outlasts and a zero poll interval, so the
 * ledger, not the clock, ends it: the most calls an idle long-poll can
 * spend on that host, not its cost at the route defaults. At the
 * defaults (25 s at 1 s) the `fetch` host also ends on the ledger, at the
 * same 44 calls, while the R2 binding's timeout ends it at 52; both are
 * pinned by `packages/server/src/http/since.test.ts` under fake timers,
 * which this real-time program cannot use. A `since-busy` cell is one
 * long-poll from an empty cursor over a 200-entry unfolded tail: the
 * prefix the first request delivers. Both are deterministic.
 */

import {
  CF_FREE_EXTERNAL_REQUEST_LIMIT,
  CF_FREE_INTERNAL_REQUEST_LIMIT,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  MemoryStorage,
  type RequestPool,
} from "@baerly/protocol";
import { Db } from "../../packages/server/src/db.ts";
import { longPollSince } from "../../packages/server/src/http/since.ts";
import {
  createObservabilityContext,
  runWithContext,
} from "../../packages/server/src/observability/context.ts";
import { chargedStorage } from "./ledgered-storage.ts";
import type { CallCounts } from "./request-counting-storage.ts";

const APP = "rc";
const TENANT = "t";
const COLL = "docs";
const CURRENT_JSON_KEY = `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`;
/** Unfolded entries behind a busy poll: more than one request over `fetch` can deliver. */
export const SINCE_BUSY_TAIL = 200;

/** The Workers Free hosts: a cell-name prefix and the pool its storage charges. */
export const SINCE_HOSTS: ReadonlyArray<{ readonly name: string; readonly pool: RequestPool }> = [
  { name: "free-fetch", pool: "external" },
  { name: "free-r2", pool: "internal" },
];

const FREE_LIMITS = {
  internal: CF_FREE_INTERNAL_REQUEST_LIMIT,
  external: CF_FREE_EXTERNAL_REQUEST_LIMIT,
};

const seed = async (tail: number): Promise<MemoryStorage> => {
  const storage = new MemoryStorage();
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "request-count-since", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
  const coll = Db.create({ storage, app: APP, tenant: TENANT }).collection(COLL);
  await runWithContext(
    createObservabilityContext({ maintenance: { disabled: true } }),
    async () => {
      for (let i = 0; i < tail; i++) {
        await coll.insert({ _id: `d${String(i).padStart(3, "0")}`, n: i });
      }
    },
  );
  return storage;
};

/** One long-poll from `cursor` under a fresh Free ledger on `pool`. */
const measure = async (
  storage: MemoryStorage,
  pool: RequestPool,
  cursor: string,
): Promise<CallCounts> => {
  const charged = chargedStorage(storage, pool, FREE_LIMITS);
  const db = Db.create({ storage: charged.storage, app: APP, tenant: TENANT });
  await runWithContext(createObservabilityContext({ ledger: charged.ledger }), () =>
    longPollSince({
      db,
      collection: COLL,
      cursor,
      // No budget outlasts this deadline; a zero interval keeps the run fast.
      timeoutMs: 3_600_000,
      pollIntervalMs: 0,
    }),
  );
  return charged.read();
};

/** The `since` cells: idle (no timeout) and busy, per Free host. */
export const sinceCells = async (): Promise<Array<{ name: string; counts: CallCounts }>> => {
  const idle = await seed(1);
  // The client's steady state: it holds the cursor of the newest entry.
  const caughtUp = await longPollSince({
    db: Db.create({ storage: idle, app: APP, tenant: TENANT }),
    collection: COLL,
    cursor: "",
  });
  const cursor = caughtUp.next_cursor;
  const busy = await seed(SINCE_BUSY_TAIL);
  const cells: Array<{ name: string; counts: CallCounts }> = [];
  for (const host of SINCE_HOSTS) {
    cells.push({
      name: `${host.name}:since-idle-no-timeout`,
      counts: await measure(idle, host.pool, cursor),
    });
    cells.push({
      name: `${host.name}:since-busy tail=${SINCE_BUSY_TAIL}`,
      counts: await measure(busy, host.pool, ""),
    });
  }
  return cells;
};
