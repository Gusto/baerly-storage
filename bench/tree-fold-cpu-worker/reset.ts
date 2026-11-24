/**
 * Return a tenant to its fixture after a fold tick. A tick writes only
 * its fold record, fresh tree nodes under an attempt it mints, and the
 * head (one CAS); it deletes nothing. The fixture has no fold record. So
 * the reset deletes every fold record and every node whose attempt is
 * not the fixture's, and puts the saved fixture head back. It runs as its own
 * request, so its work never lands in a measured sample.
 *
 * Written against the slice of the R2 binding it uses, so the Node tests
 * run it on an in-memory bucket.
 */
import { treeNodeKeyPrefix, treeRecordKeyPrefix } from "../../packages/server/src/tree/key.ts";
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
  /** Fold records deleted: one per tick that published or tried to. */
  readonly records: number;
  /** Fixture nodes left. */
  readonly nodes: number;
}

/** R2 deletes at most this many keys per call. */
const DELETE_BATCH = 1000;

/**
 * Delete every fold record of `tenant` and every node outside the fixture
 * attempt, and restore the saved fixture head.
 *
 * @throws Error — the tenant has no saved fixture head (it was never
 *   uploaded).
 */
export const resetTenant = async (bucket: ResetBucket, tenant: string): Promise<ResetResult> => {
  const saved = await bucket.get(savedHeadKey(tenant));
  if (saved === null) {
    throw new Error(`${tenant} has no saved fixture head; upload it first`);
  }
  const listAll = async (prefix: string): Promise<string[]> => {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list({
        prefix,
        limit: 1000,
        ...(cursor !== undefined && { cursor }),
      });
      keys.push(...page.objects.map(({ key }) => key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    return keys;
  };
  const deleteAll = async (keys: readonly string[]): Promise<void> => {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      await bucket.delete(keys.slice(i, i + DELETE_BATCH));
    }
  };
  const prefix = treeNodeKeyPrefix(collectionPrefix(tenant));
  const fixtureNodes = `${prefix}${FIXTURE_ATTEMPT}/`;
  const all = await listAll(prefix);
  const stale = all.filter((key) => !key.startsWith(fixtureNodes));
  const records = await listAll(treeRecordKeyPrefix(collectionPrefix(tenant)));
  await deleteAll(stale);
  await deleteAll(records);
  await bucket.put(headKey(tenant), await saved.text());
  return { deleted: stale.length, records: records.length, nodes: all.length - stale.length };
};
