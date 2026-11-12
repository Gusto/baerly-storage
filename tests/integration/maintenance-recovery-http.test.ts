/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes. */

/**
 * main-10 exit: capacity refusal and its recovery end to end over HTTP, on
 * `memory` + `local-fs`, through the Node adapter (`baerlyNode(...).fetch`:
 * verifier, per-request maintenance context, router) and `@baerly/client`.
 *
 * The host is the Node profile with the snapshot ceiling `C` declared by
 * `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`, as an operator sets it. The capacity
 * check models `compact()` exactly, so an admitted write never leaves a
 * pending tail whose fold frees room; the backpressure state is staged as a
 * host move instead: a [3M insert, its delete] tail written before `C` was
 * lowered.
 *
 * - H1 a growth write the pending tail would make room for gets 503
 *   `MaintenancePending` (retriable, `retryAfter` on the envelope and in
 *   `Retry-After`), runs one fold in that request, and the same request
 *   resent after the hint commits. No operator step, no explicit drain.
 * - H2 `@baerly/client` retries that 503 on its own: the caller's
 *   `insert()` resolves, and the wire saw [503, 201].
 * - H3 growth past `C` gets 409 `CapacityExceeded` (not retriable, no
 *   `Retry-After`) and commits nothing; after the app shrinks rows over
 *   HTTP, the same insert is admitted through in-band maintenance alone.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ClientCollection, createBaerlyClient } from "@baerly/client";
import {
  type BaerlyAppConfig,
  MAINTENANCE_MIN_LIVE_BYTES,
  MAINTENANCE_PENDING_RETRY_AFTER_SECONDS,
  MAINTENANCE_PROFILE_NODE,
  type Storage,
} from "@baerly/protocol";
import { baerlyNode } from "@baerly/adapter-node";
import {
  commit,
  type Doc,
  drain,
  id,
  inserts,
  readIds,
  state,
} from "../fixtures/fold-stall-harness.ts";
import {
  APP,
  bootstrap,
  COLLECTION,
  makeVariants,
  TENANT,
} from "../fixtures/maintenance-harness.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** Bytes unit: well above any per-entry framing or the refusal margin. */
const M = 4096;
/** 10 rows of 2M: a ~80 KiB snapshot. */
const ROW_PAD = "x".repeat(2 * M);
/** Past the 2M of headroom below `C`. */
const GROW_PAD = "x".repeat(3 * M);
/** Well inside the headroom. */
const SMALL_PAD = "x".repeat(M / 4);
const BEARER = "recovery-token";
const ROUTE = `http://localhost/v1/c/${COLLECTION}`;

const config: BaerlyAppConfig = {
  app: APP,
  tenant: TENANT,
  target: "node",
  auth: "none",
  collections: {},
};

type Handler = (request: Request) => Response | Promise<Response>;

const serve = (storage: Storage): Handler =>
  baerlyNode({
    config,
    storage,
    observability: false,
    verifier: async (req) =>
      req.headers.get("authorization") === `Bearer ${BEARER}`
        ? { tenantPrefix: TENANT, identity: {} }
        : null,
  }).fetch;

const post = (handler: Handler, doc: Doc): Promise<Response> =>
  Promise.resolve(
    handler(
      new Request(ROUTE, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        body: JSON.stringify({ doc }),
      }),
    ),
  );

/** A client over `handler` that records every response status it sees. */
const clientOn = (handler: Handler) => {
  const statuses: number[] = [];
  const client = createBaerlyClient({
    baseUrl: "http://localhost",
    headers: { Authorization: `Bearer ${BEARER}` },
    fetch: async (request) => {
      const res = await handler(request);
      statuses.push(res.status);
      return res;
    },
  });
  return { tickets: client.collection(COLLECTION) as ClientCollection<Doc>, statuses };
};

const VARIANTS = makeVariants("baerly-recovery-http-");

describe("main-10 exit: refusal and recovery over HTTP (Node adapter, declared C)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const variant of VARIANTS) {
    describe(variant.label, () => {
      let cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const c of cleanups) {
          await c();
        }
        cleanups = [];
      });

      /** 10 padded rows folded on Node; `C` declared at stored + 2M. */
      const nearC = async (): Promise<Storage> => {
        const made = await variant.build();
        if (made.cleanup) {
          cleanups.push(made.cleanup);
        }
        await bootstrap(made.storage, "recovery-http", MAINTENANCE_MIN_LIVE_BYTES);
        await commit(made.storage, inserts(0, 10, ROW_PAD));
        await drain(made.storage, MAINTENANCE_PROFILE_NODE);
        const s = await state(made.storage);
        expect(s).toMatchObject({ start: 10, tail: 10, rows: 10 });
        vi.stubEnv("BAERLY_MAINTENANCE_MAX_FOLD_BYTES", String(s.bytes + 2 * M));
        return made.storage;
      };

      /** Host move: a [3M insert, its delete] tail written before `C` was lowered. */
      const pendingPeak = async (): Promise<Storage> => {
        const storage = await nearC();
        await commit(storage, [
          { op: "I", i: 10, pad: GROW_PAD },
          { op: "D", i: 10 },
        ]);
        await expect(state(storage)).resolves.toMatchObject({ start: 10, tail: 12 });
        return storage;
      };

      test("H1: 503 MaintenancePending with the retry hint, one fold in that request, then the resend commits", async () => {
        const storage = await pendingPeak();
        const handler = serve(storage);
        const doc: Doc = { _id: id(11), n: 0, pad: SMALL_PAD };

        const refused = await post(handler, doc);
        expect(refused.status).toBe(503);
        expect(refused.headers.get("retry-after")).toBe(
          String(MAINTENANCE_PENDING_RETRY_AFTER_SECONDS),
        );
        await expect(refused.json()).resolves.toMatchObject({
          error: {
            code: "MaintenancePending",
            retriable: true,
            retryAfter: MAINTENANCE_PENDING_RETRY_AFTER_SECONDS,
          },
        });
        // The refusal folded the pending tail and committed nothing.
        await expect(state(storage)).resolves.toMatchObject({ start: 12, tail: 12, rows: 10 });

        const resent = await post(handler, doc);
        expect(resent.status).toBe(201);
        await expect(resent.json()).resolves.toEqual({ _id: id(11) });
        await expect(readIds(storage)).resolves.toContain(id(11));
      });

      test("H2: the client retries MaintenancePending itself; insert() resolves after [503, 201]", async () => {
        const storage = await pendingPeak();
        const { tickets, statuses } = clientOn(serve(storage));

        await expect(tickets.insert({ _id: id(11), n: 0, pad: SMALL_PAD })).resolves.toEqual({
          _id: id(11),
        });
        expect(statuses).toEqual([503, 201]);
        await expect(tickets.get(id(11))).resolves.toMatchObject({ _id: id(11) });
      });

      test("H3: 409 CapacityExceeded past C commits nothing; after shrinking rows over HTTP the insert is admitted with no operator step", async () => {
        const storage = await nearC();
        const handler = serve(storage);
        const big: Doc = { _id: id(10), n: 0, pad: GROW_PAD };

        const refused = await post(handler, big);
        expect(refused.status).toBe(409);
        expect(refused.headers.get("retry-after")).toBeNull();
        await expect(refused.json()).resolves.toMatchObject({
          error: { code: "CapacityExceeded", retriable: false },
        });
        await expect(state(storage)).resolves.toMatchObject({ start: 10, tail: 10 });

        // App-side remedy: shrink two 2M rows (frees 4M), then insert again.
        const { tickets, statuses } = clientOn(handler);
        for (const i of [0, 1]) {
          await expect(tickets.update(id(i), { pad: "" })).resolves.toEqual({ modified: 1 });
        }
        await expect(tickets.insert(big)).resolves.toEqual({ _id: id(10) });
        expect(statuses).not.toContain(409);
        expect(statuses.at(-1)).toBe(201);
        await expect(readIds(storage)).resolves.toHaveLength(11);
      });
    });
  }
});
