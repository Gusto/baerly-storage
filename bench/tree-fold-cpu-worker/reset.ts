/**
 * Return a tenant to its fixture after a fold tick. A tick writes only
 * fresh tree nodes, under an attempt it mints, and the head (one CAS); it
 * deletes nothing. So the reset deletes every node whose attempt is not
 * the fixture's and puts the saved fixture head back. It runs as its own
 * request, so its work never lands in a measured sample.
 *
 * Written against the slice of the R2 binding it uses, so the Node tests
 * run it on an in-memory bucket.
 */
import { treeNodeKeyPrefix } from "../../packages/server/src/tree/key.ts";
import { collectionPrefix, FIXTURE_ATTEMPT, headKey, savedHeadKey } from "./cells.ts";

/** The R2 binding calls a reset makes. */
export interface ResetBucket {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: readonly { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string[]): Promise<void>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
}

export interface ResetResult {
  /** Nodes deleted: every node a tick wrote. */
  readonly deleted: number;
  /** Fixture nodes left. */
  readonly nodes: number;
}

/** R2 deletes at most this many keys per call. */
const DELETE_BATCH = 1000;

/**
 * Delete every node of `tenant` outside the fixture attempt and restore the
 * saved fixture head.
 *
 * @throws Error — the tenant has no saved fixture head (it was never
 *   uploaded).
 */
export const resetTenant = async (bucket: ResetBucket, tenant: string): Promise<ResetResult> => {
  const saved = await bucket.get(savedHeadKey(tenant));
  if (saved === null) {
    throw new Error(`${tenant} has no saved fixture head; upload it first`);
  }
  const prefix = treeNodeKeyPrefix(collectionPrefix(tenant));
  const fixtureNodes = `${prefix}${FIXTURE_ATTEMPT}/`;
  const stale: string[] = [];
  let nodes = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix,
      limit: 1000,
      ...(cursor !== undefined && { cursor }),
    });
    for (const { key } of page.objects) {
      if (key.startsWith(fixtureNodes)) {
        nodes += 1;
      } else {
        stale.push(key);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  for (let i = 0; i < stale.length; i += DELETE_BATCH) {
    await bucket.delete(stale.slice(i, i + DELETE_BATCH));
  }
  await bucket.put(headKey(tenant), await saved.text());
  return { deleted: stale.length, nodes };
};
